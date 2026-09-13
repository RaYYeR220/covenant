// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CovenantManager} from "../src/CovenantManager.sol";
import {Term, Line, Status, CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "../src/libraries/Types.sol";
import {CovenantBase} from "./utils/CovenantBase.sol";

contract CovenantManagerOpenTest is CovenantBase {
    event LineOpened(
        uint256 indexed lineId, address indexed borrower, address indexed linkedWallet, uint256 bond, bytes32 memoHash
    );

    function test_openLine_storesLineAndPullsBond() public {
        uint256 balBefore = wctc.balanceOf(borrower);
        vm.expectEmit(address(manager));
        emit LineOpened(1, borrower, wallet, BOND, keccak256("memo"));
        uint256 id = _openStandard();

        assertEq(id, 1);
        Line memory l = _line(id);
        assertEq(l.borrower, borrower);
        assertEq(l.linkedWallet, wallet);
        assertEq(l.bond, BOND);
        assertEq(uint8(l.status), uint8(Status.Active));
        assertEq(l.memoHash, keccak256("memo"));
        assertEq(wctc.balanceOf(borrower), balBefore - BOND);
        assertEq(wctc.balanceOf(address(manager)), BOND);
        assertEq(manager.activeLineOf(wallet), id);
        assertEq(manager.nonces(wallet), 1);
        assertEq(manager.termsOf(id).length, 3);
    }

    function test_openLine_setsActivationHeightPerChain() public {
        Term[] memory t = _terms3(
            _term(CROSS_DEFAULT, MAINNET, address(0), 0),
            _term(CROSS_DEFAULT, SEPOLIA, address(0), 0),
            _term(NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 1e6)
        );
        uint256 id = _open(t, BOND);
        assertEq(manager.activeFromHeight(id, MAINNET), MAINNET_ATTESTED + 1);
        assertEq(manager.activeFromHeight(id, SEPOLIA), SEPOLIA_ATTESTED + 1);
        assertEq(manager.sourcePoolOf(id, MAINNET), AAVE_MAINNET);
        assertEq(manager.sourcePoolOf(id, SEPOLIA), AAVE_SEPOLIA);
    }

    function test_openLine_registryChangeDoesNotAffectExistingLine() public {
        uint256 id = _openStandard();
        vm.prank(owner);
        manager.setAavePool(MAINNET, address(0xBAD));
        assertEq(manager.sourcePoolOf(id, MAINNET), AAVE_MAINNET);
    }

    function test_eip712_domainMatchesSpec() public view {
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domain = keccak256(
            abi.encode(typeHash, keccak256("Covenant"), keccak256("1"), block.chainid, address(manager))
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("LinkWallet(address borrower,address wallet,uint256 nonce,uint256 deadline)"),
                borrower,
                wallet,
                uint256(0),
                uint256(123)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        assertEq(manager.linkWalletDigest(borrower, wallet, 0, 123), expected);
    }

    // ------------------------------------------------------------ EIP-712 negatives

    function test_openLine_badSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(0xB0B, borrower, wallet, 0, deadline); // wrong key
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.InvalidLinkSignature.selector);
        manager.openLine(_standardTerms(), BOND, wallet, deadline, sig, bytes32(0));
    }

    function test_openLine_signatureForOtherBorrower() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(walletPk, reporter, wallet, 0, deadline);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.InvalidLinkSignature.selector);
        manager.openLine(_standardTerms(), BOND, wallet, deadline, sig, bytes32(0));
    }

    function test_openLine_malformedSignature() public {
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        manager.openLine(_standardTerms(), BOND, wallet, block.timestamp, hex"010203", bytes32(0));
    }

    function test_openLine_expiredSignature() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(walletPk, borrower, wallet, 0, deadline);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.LinkSignatureExpired.selector);
        manager.openLine(_standardTerms(), BOND, wallet, deadline, sig, bytes32(0));
    }

    function test_openLine_replayedNonce() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(walletPk, borrower, wallet, 0, deadline);
        vm.prank(borrower);
        uint256 id = manager.openLine(_standardTerms(), BOND, wallet, deadline, sig, bytes32(0));
        vm.prank(borrower);
        manager.closeLine(id);

        vm.prank(borrower);
        vm.expectRevert(CovenantManager.InvalidLinkSignature.selector);
        manager.openLine(_standardTerms(), BOND, wallet, deadline, sig, bytes32(0));
    }

    function test_openLine_oneActiveLinePerWallet() public {
        _openStandard();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(walletPk, borrower, wallet, 1, deadline);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.WalletHasActiveLine.selector);
        manager.openLine(_standardTerms(), BOND, wallet, deadline, sig, bytes32(0));
    }

    function test_openLine_newLineAllowedAfterClose() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.closeLine(id);
        assertEq(manager.activeLineOf(wallet), 0);
        uint256 id2 = _openStandard();
        assertEq(id2, 2);
    }

    // ------------------------------------------------------------ term validation

    function _expectOpenRevert(Term[] memory t, bytes memory err) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(walletPk, borrower, wallet, 0, deadline);
        vm.prank(borrower);
        vm.expectRevert(err);
        manager.openLine(t, BOND, wallet, deadline, sig, bytes32(0));
    }

    function test_validate_noTerms() public {
        _expectOpenRevert(new Term[](0), abi.encodeWithSelector(CovenantManager.InvalidTermCount.selector));
    }

    function test_validate_tooManyTerms() public {
        Term[] memory t = new Term[](9);
        for (uint256 i; i < 9; ++i) {
            t[i] = _term(DEBT_CAP, MAINNET, address(uint160(i + 1)), 1);
        }
        _expectOpenRevert(t, abi.encodeWithSelector(CovenantManager.InvalidTermCount.selector));
    }

    function test_validate_unknownKind() public {
        _expectOpenRevert(
            _terms1(_term(3, MAINNET, address(0), 0)), abi.encodeWithSelector(CovenantManager.InvalidTerm.selector)
        );
    }

    function test_validate_crossDefaultMustBeCanonical() public {
        _expectOpenRevert(
            _terms1(_term(CROSS_DEFAULT, MAINNET, address(1), 0)),
            abi.encodeWithSelector(CovenantManager.InvalidTerm.selector)
        );
        _expectOpenRevert(
            _terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 1)),
            abi.encodeWithSelector(CovenantManager.InvalidTerm.selector)
        );
    }

    function test_validate_retiredFlagRejected() public {
        Term memory t = _term(CROSS_DEFAULT, MAINNET, address(0), 0);
        t.retired = true;
        _expectOpenRevert(_terms1(t), abi.encodeWithSelector(CovenantManager.InvalidTerm.selector));
    }

    function test_validate_sourceNotRegistered() public {
        _expectOpenRevert(
            _terms1(_term(CROSS_DEFAULT, 42, address(0), 0)),
            abi.encodeWithSelector(CovenantManager.SourceNotRegistered.selector, uint64(42))
        );
    }

    function test_validate_pledgeTokenNotAllowed() public {
        _expectOpenRevert(
            _terms1(_term(NEGATIVE_PLEDGE, MAINNET, address(0xDA1), 1)),
            abi.encodeWithSelector(CovenantManager.PledgeTokenNotAllowed.selector, MAINNET, address(0xDA1))
        );
    }

    function test_validate_debtCapAboveCeiling() public {
        uint256 ceiling = manager.maxDebtCapThreshold();
        _expectOpenRevert(
            _terms1(_term(DEBT_CAP, MAINNET, USDC_MAINNET, ceiling + 1)),
            abi.encodeWithSelector(CovenantManager.ThresholdAboveCeiling.selector)
        );
    }

    function test_validate_pledgeAboveCeiling() public {
        uint256 ceiling = manager.maxPledgeThreshold();
        _expectOpenRevert(
            _terms1(_term(NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, ceiling + 1)),
            abi.encodeWithSelector(CovenantManager.ThresholdAboveCeiling.selector)
        );
    }

    function test_validate_duplicateTerm() public {
        Term[] memory t = new Term[](2);
        t[0] = _term(DEBT_CAP, MAINNET, USDC_MAINNET, 5);
        t[1] = _term(DEBT_CAP, MAINNET, USDC_MAINNET, 7);
        _expectOpenRevert(t, abi.encodeWithSelector(CovenantManager.DuplicateTerm.selector));
    }

    function test_validate_chainNotAttested() public {
        chainInfo.clear(MAINNET);
        _expectOpenRevert(
            _terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 0)),
            abi.encodeWithSelector(CovenantManager.ChainNotAttested.selector, MAINNET)
        );
    }

    function test_validate_zeroBond() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(walletPk, borrower, wallet, 0, deadline);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.ZeroAmount.selector);
        manager.openLine(_standardTerms(), 0, wallet, deadline, sig, bytes32(0));
    }
}
