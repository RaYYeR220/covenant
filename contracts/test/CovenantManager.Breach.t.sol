// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {CovenantManager} from "../src/CovenantManager.sol";
import {CovenantPredicates} from "../src/libraries/CovenantPredicates.sol";
import {ICreditRecord} from "../src/interfaces/ICreditRecord.sol";
import {Term, Line, Status, CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "../src/libraries/Types.sol";
import {CovenantBase} from "./utils/CovenantBase.sol";
import {TxBuilder} from "./utils/TxBuilder.sol";

contract CovenantManagerBreachTest is CovenantBase {
    event CovenantBreached(
        uint256 indexed lineId, uint8 indexed termIndex, address indexed reporter, bytes32 replayKey, uint256 bounty
    );

    uint64 internal constant H = MAINNET_ATTESTED + 10;
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 200 ether);
    }

    function _predicateErr(CovenantPredicates.Reason r) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(CovenantManager.PredicateFailed.selector, r);
    }

    function _borrowTx(uint256 amount) internal pure returns (bytes memory) {
        return TxBuilder.encode(TxBuilder.borrow(AAVE_MAINNET, USDC_MAINNET, vm.addr(0xA11CE), amount));
    }

    function _pledgeTx(uint256 amount) internal pure returns (bytes memory) {
        return TxBuilder.encode(TxBuilder.transfer(USDC_MAINNET, vm.addr(0xA11CE), address(0xBEEF), amount));
    }

    // ------------------------------------------------------------ happy path

    function test_reportBreach_crossDefault() public {
        bytes32 key = _replayKey(MAINNET, H, 7, 0);
        vm.expectEmit(address(manager));
        emit CovenantBreached(id, 0, reporter, key, 10 ether);
        bytes32 returned = _report(id, 0, H, _liquidationTx(wallet), 7, 0);

        assertEq(returned, key);
        Line memory l = _line(id);
        assertEq(uint8(l.status), uint8(Status.Breached));
        assertEq(l.bond, 90 ether);
        assertEq(l.breachedTerm, 0);
        assertEq(l.breachHeight, H);
        assertEq(l.breachAmount, 4000e6);
        assertEq(l.breachedAt, block.timestamp);
        assertEq(l.graceEnds, block.timestamp + 1 hours);
        assertEq(wctc.balanceOf(reporter), 10 ether);
        assertEq(wctc.balanceOf(address(manager)), 90 ether);
        assertTrue(manager.usedReplayKeys(key));
        assertEq(record.recordOf(wallet).breaches, 1);
        assertEq(verifier.singleCalls(), 1);
    }

    function test_reportBreach_debtCap() public {
        _report(id, 1, H, _borrowTx(1000e6 + 1), 3, 0);
        Line memory l = _line(id);
        assertEq(uint8(l.status), uint8(Status.Breached));
        assertEq(l.breachAmount, 1000e6 + 1);
    }

    function test_reportBreach_negativePledge() public {
        _report(id, 2, H, _pledgeTx(501e6), 3, 0);
        assertEq(_line(id).breachAmount, 501e6);
    }

    function test_reportBreach_atActivationHeight() public {
        _report(id, 0, MAINNET_ATTESTED + 1, _liquidationTx(wallet), 1, 0);
        assertEq(uint8(_line(id).status), uint8(Status.Breached));
    }

    // ------------------------------------------------------------ required negatives

    function test_reportBreach_replayedProof() public {
        _report(id, 0, H, _liquidationTx(wallet), 7, 0);
        vm.prank(borrower);
        manager.repay(id, type(uint256).max); // cure, line Active again (term 0 retired)

        bytes32 key = _replayKey(MAINNET, H, 7, 0);
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.ProofAlreadyUsed.selector, key));
        manager.reportBreach(id, 1, H, _liquidationTx(wallet), _merkle(7), _continuity(), 0);
    }

    function test_reportBreach_phantomTxIndexStillReplayProtected() public {
        bytes memory txb = _pledgeTx(501e6);
        _report(id, 2, H, txb, 7, 0);
        vm.prank(borrower);
        manager.repay(id, type(uint256).max);
        // same tx bytes and log, different sibling path (would pass a duplicate-leaf tree)
        bytes32 contentKey = keccak256(abi.encode(MAINNET, H, keccak256(txb), uint256(0)));
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.ProofAlreadyUsed.selector, contentKey));
        manager.reportBreach(id, 1, H, txb, _merkle(8), _continuity(), 0);
    }

    function test_reportBreach_spoofedEmitter() public {
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(address(0xEE11), wallet, 1));
        vm.prank(reporter);
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.WrongEmitter));
        manager.reportBreach(id, 0, H, txb, _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_wrongWallet() public {
        vm.prank(reporter);
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.WrongWallet));
        manager.reportBreach(id, 0, H, _liquidationTx(address(0x0DD)), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_preActivationHeight() public {
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.HeightBeforeActivation.selector);
        manager.reportBreach(id, 0, MAINNET_ATTESTED, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_failedReceipt() public {
        bytes memory txb = TxBuilder.encode(0, TxBuilder.one(TxBuilder.liquidation(AAVE_MAINNET, wallet, 1)));
        vm.prank(reporter);
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.ReceiptFailed));
        manager.reportBreach(id, 0, H, txb, _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_verifierReturnsFalse() public {
        verifier.setFail(true);
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.ProofInvalid.selector);
        manager.reportBreach(id, 0, H, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_verifierReverts() public {
        verifier.setRevert(true);
        vm.prank(reporter);
        vm.expectRevert(bytes("verifier: bad proof"));
        manager.reportBreach(id, 0, H, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_logIndexOutOfBounds() public {
        vm.prank(reporter);
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.LogIndexOutOfBounds));
        manager.reportBreach(id, 0, H, _liquidationTx(wallet), _merkle(1), _continuity(), 1);
    }

    function test_reportBreach_thresholdNotExceeded() public {
        vm.prank(reporter);
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.ThresholdNotExceeded));
        manager.reportBreach(id, 1, H, _borrowTx(1000e6), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_nonActiveLine() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.LineNotActive.selector);
        manager.reportBreach(id, 2, H, _pledgeTx(501e6), _merkle(2), _continuity(), 0);
    }

    function test_reportBreach_closedLine() public {
        vm.startPrank(borrower);
        manager.repay(id, type(uint256).max);
        manager.closeLine(id);
        vm.stopPrank();
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.LineNotActive.selector);
        manager.reportBreach(id, 0, H, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_retiredTerm() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.prank(borrower);
        manager.repay(id, type(uint256).max);
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.TermRetired.selector);
        manager.reportBreach(id, 0, H + 1, _liquidationTx(wallet), _merkle(2), _continuity(), 0);
    }

    function test_reportBreach_termIndexOutOfBounds() public {
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.TermIndexOutOfBounds.selector);
        manager.reportBreach(id, 3, H, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
    }

    function test_reportBreach_wrongChainLogNotAccepted() public {
        // a Sepolia pool log cannot satisfy a mainnet term: the term fixes chainKey and emitter
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(AAVE_SEPOLIA, wallet, 1));
        vm.prank(reporter);
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.WrongEmitter));
        manager.reportBreach(id, 0, H, txb, _merkle(1), _continuity(), 0);
    }

    function test_draw_whileBreached() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.LineNotActive.selector);
        manager.draw(id, 1 ether);
    }

    // ------------------------------------------------------------ preview

    function test_previewBreach_matchesAndExplains() public {
        (bool ok, uint256 amount, string memory reason) =
            manager.previewBreach(id, 0, H, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
        assertTrue(ok);
        assertEq(amount, 4000e6);
        assertEq(reason, "");

        (ok,, reason) = manager.previewBreach(id, 0, H, _liquidationTx(address(0x0DD)), _merkle(1), _continuity(), 0);
        assertFalse(ok);
        assertEq(reason, "wrong wallet");

        (ok,, reason) = manager.previewBreach(id, 0, MAINNET_ATTESTED, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
        assertFalse(ok);
        assertEq(reason, "height before activation");

        verifier.setRevert(true);
        (ok,, reason) = manager.previewBreach(id, 0, H, _liquidationTx(wallet), _merkle(1), _continuity(), 0);
        assertFalse(ok);
        assertEq(reason, "proof invalid");
        verifier.setRevert(false);

        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        (ok,, reason) = manager.previewBreach(id, 1, H, _borrowTx(2000e6), _merkle(2), _continuity(), 0);
        assertFalse(ok);
        assertEq(reason, "line not active");
    }

    function test_previewPredicate_decodeOnly() public view {
        (bool ok, uint256 amount, string memory reason) =
            manager.previewPredicate(DEBT_CAP, MAINNET, USDC_MAINNET, 10, wallet, _borrowTx(11), 0);
        assertTrue(ok);
        assertEq(amount, 11);
        assertEq(reason, "");
        (ok,, reason) = manager.previewPredicate(NEGATIVE_PLEDGE, MAINNET, address(0xDA1), 10, wallet, _pledgeTx(11), 0);
        assertFalse(ok);
        assertEq(reason, "token not allowed");
        (ok,, reason) = manager.previewPredicate(CROSS_DEFAULT, 99, address(0), 0, wallet, _liquidationTx(wallet), 0);
        assertFalse(ok);
        assertEq(reason, "source not registered");
    }

    // ------------------------------------------------------------ cure by repayment

    function test_cureByRepayment() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.warp(block.timestamp + 30 minutes);
        vm.prank(borrower);
        manager.repay(id, type(uint256).max);

        Line memory l = _line(id);
        assertEq(uint8(l.status), uint8(Status.Active));
        assertTrue(manager.termsOf(id)[0].retired);
        assertEq(record.recordOf(wallet).cures, 1);
        // CROSS_DEFAULT weight gone, bond reduced by bounty: 90 * 2.25
        assertEq(manager.limitOf(id), 90 ether * 22_500 / 10_000);
    }

    function test_cureByRepayment_partialDoesNotCure() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.prank(borrower);
        manager.repay(id, 100 ether);
        assertEq(uint8(_line(id).status), uint8(Status.Breached));
    }

    function test_cureByRepayment_zeroDebtLine() public {
        uint256 walletPk2 = 0xB0B2;
        address wallet2 = vm.addr(walletPk2);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = manager.linkWalletDigest(borrower, wallet2, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk2, digest);
        vm.prank(borrower);
        uint256 id2 = manager.openLine(
            _terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 0)), BOND, wallet2, deadline, abi.encodePacked(r, s, v), 0
        );
        _report(id2, 0, H, _liquidationTx(wallet2), 1, 0);
        vm.prank(borrower);
        manager.repay(id2, 0);
        assertEq(uint8(_line(id2).status), uint8(Status.Active));
    }

    function test_draw_blockedWhenPrincipalAboveReducedLimit() public {
        vm.prank(borrower);
        manager.draw(id, 100 ether); // principal 300 of limit 325
        _report(id, 2, H, _pledgeTx(700e6), 3, 0);
        bytes memory backTx = TxBuilder.encode(TxBuilder.transfer(USDC_MAINNET, address(0xBEEF), wallet, 700e6));
        manager.cureByProof(id, H + 1, backTx, _merkle(4), _continuity(), 0);

        // cured without repaying: pledge weight gone and bond cut by the bounty -> 90 * 2.75 = 247.5 < 300
        assertEq(manager.limitOf(id), 247.5 ether);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.ExceedsLimit.selector);
        manager.draw(id, 1);

        vm.prank(borrower);
        manager.repay(id, 60 ether);
        vm.prank(borrower);
        manager.draw(id, 1 ether); // back under the limit
    }

    // ------------------------------------------------------------ cure by proof

    function test_cureByProof_debtCap() public {
        _report(id, 1, H, _borrowTx(1500e6), 3, 0);
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1500e6));
        vm.prank(borrower);
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);

        assertEq(uint8(_line(id).status), uint8(Status.Active));
        assertTrue(manager.termsOf(id)[1].retired);
        assertTrue(manager.usedReplayKeys(_replayKey(MAINNET, H + 1, 9, 0)));
        assertEq(record.recordOf(wallet).cures, 1);
    }

    function test_cureByProof_negativePledge() public {
        _report(id, 2, H, _pledgeTx(700e6), 3, 0);
        bytes memory backTx = TxBuilder.encode(TxBuilder.transfer(USDC_MAINNET, address(0xBEEF), wallet, 700e6));
        vm.prank(reporter); // anyone may submit the cure
        manager.cureByProof(id, H + 5, backTx, _merkle(9), _continuity(), 0);
        assertEq(uint8(_line(id).status), uint8(Status.Active));
        assertTrue(manager.termsOf(id)[2].retired);
    }

    function test_cureByProof_afterGrace() public {
        _report(id, 1, H, _borrowTx(1500e6), 3, 0);
        vm.warp(block.timestamp + 1 hours + 1);
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1500e6));
        vm.expectRevert(CovenantManager.GracePeriodOver.selector);
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);
    }

    function test_cureByProof_lowerAmount() public {
        _report(id, 1, H, _borrowTx(1500e6), 3, 0);
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1500e6 - 1));
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.AmountTooLow));
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);
    }

    function test_cureByProof_heightNotAfterBreach() public {
        _report(id, 1, H, _borrowTx(1500e6), 3, 0);
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1500e6));
        vm.expectRevert(CovenantManager.CureHeightTooLow.selector);
        manager.cureByProof(id, H, repayTx, _merkle(9), _continuity(), 0);
    }

    function test_cureByProof_crossDefaultNotCurable() public {
        _report(id, 0, H, _liquidationTx(wallet), 3, 0);
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1e30));
        vm.expectRevert(CovenantManager.NotCurableByProof.selector);
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);
    }

    function test_cureByProof_anyReserveTermMustRepayBreachedReserve() public {
        uint256 walletPk2 = 0xB0B3;
        address wallet2 = vm.addr(walletPk2);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk2, manager.linkWalletDigest(borrower, wallet2, 0, deadline));
        vm.prank(borrower);
        uint256 id2 = manager.openLine(
            _terms1(_term(DEBT_CAP, MAINNET, address(0), 1000e6)), BOND, wallet2, deadline, abi.encodePacked(r, s, v), 0
        );
        address weth = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        _report(id2, 0, H, TxBuilder.encode(TxBuilder.borrow(AAVE_MAINNET, weth, wallet2, 5e18)), 3, 0);

        // repaying a different reserve with a numerically larger raw amount is not a cure
        bytes memory wrongReserve = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet2, 6e18));
        vm.expectRevert(_predicateErr(CovenantPredicates.Reason.WrongAsset));
        manager.cureByProof(id2, H + 1, wrongReserve, _merkle(9), _continuity(), 0);

        bytes memory rightReserve = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, weth, wallet2, 5e18));
        manager.cureByProof(id2, H + 1, rightReserve, _merkle(9), _continuity(), 0);
        assertEq(uint8(_line(id2).status), uint8(Status.Active));
    }

    function test_cureByProof_notBreached() public {
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1));
        vm.expectRevert(CovenantManager.LineNotBreached.selector);
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);
    }

    function test_cureByProof_replayedProof() public {
        _report(id, 1, H, _borrowTx(1500e6), 3, 0);
        bytes memory repayTx = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, wallet, 1500e6));
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);
        _report(id, 2, H, _pledgeTx(501e6), 4, 0);
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.ProofAlreadyUsed.selector, _replayKey(MAINNET, H + 1, 9, 0)));
        manager.cureByProof(id, H + 1, repayTx, _merkle(9), _continuity(), 0);
    }

    // ------------------------------------------------------------ default

    function test_settleDefault_beforeGraceEnds() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(CovenantManager.GracePeriodActive.selector);
        manager.settleDefault(id);
    }

    function test_settleDefault_lossSocialized() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0); // bond 100 -> 90
        vm.warp(block.timestamp + 2 hours);

        uint256 assetsBefore = pool.totalAssets();
        vm.prank(keeper);
        manager.settleDefault(id);

        uint256 keeperReward = 90 ether * 50 / 10_000;
        uint256 recovered = 90 ether - keeperReward;
        assertEq(wctc.balanceOf(keeper), keeperReward);
        assertEq(wctc.balanceOf(address(manager)), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        // pool lost principal 200, got back `recovered`
        assertEq(pool.totalAssets(), assetsBefore - 200 ether + recovered);

        Line memory l = _line(id);
        assertEq(uint8(l.status), uint8(Status.Defaulted));
        assertEq(l.bond, 0);
        assertEq(l.principal, 0);
        assertEq(manager.activeLineOf(wallet), 0);
        assertEq(record.recordOf(wallet).defaults, 1);
    }

    function test_settleDefault_excessBondRefunded() public {
        vm.prank(borrower);
        manager.repay(id, 190 ether); // principal 10
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.warp(block.timestamp + 2 hours);
        uint256 debt = manager.debtOf(id);
        uint256 borrowerBefore = wctc.balanceOf(borrower);

        vm.prank(keeper);
        manager.settleDefault(id);

        uint256 keeperReward = 90 ether * 50 / 10_000;
        assertEq(wctc.balanceOf(borrower), borrowerBefore + 90 ether - keeperReward - debt);
        assertEq(pool.outstandingPrincipal(), 0);
    }

    function test_settleDefault_notBreached() public {
        vm.expectRevert(CovenantManager.LineNotBreached.selector);
        manager.settleDefault(id);
    }

    function test_repayAfterGraceStillCuresBeforeSettlement() public {
        _report(id, 0, H, _liquidationTx(wallet), 1, 0);
        vm.warp(block.timestamp + 5 hours);
        vm.prank(borrower);
        manager.repay(id, type(uint256).max);
        assertEq(uint8(_line(id).status), uint8(Status.Active));
        vm.expectRevert(CovenantManager.LineNotBreached.selector);
        manager.settleDefault(id);
    }
}
