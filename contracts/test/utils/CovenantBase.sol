// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

import {WCTC} from "../../src/WCTC.sol";
import {CovenantPool} from "../../src/CovenantPool.sol";
import {CreditRecord} from "../../src/CreditRecord.sol";
import {CovenantManager} from "../../src/CovenantManager.sol";
import {Term, Line, Status, CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "../../src/libraries/Types.sol";

import {MockNativeQueryVerifier} from "../mocks/MockNativeQueryVerifier.sol";
import {MockChainInfo} from "../mocks/MockChainInfo.sol";
import {CovenantManagerHarness} from "../harness/CovenantManagerHarness.sol";
import {TxBuilder} from "./TxBuilder.sol";

abstract contract CovenantBase is Test {
    address internal constant VERIFIER_ADDR = 0x0000000000000000000000000000000000000FD2;
    address internal constant CHAIN_INFO_ADDR = 0x0000000000000000000000000000000000000fD3;

    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant MAINNET = 3;
    address internal constant AAVE_MAINNET = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant AAVE_SEPOLIA = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address internal constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    uint64 internal constant MAINNET_ATTESTED = 25_967_000;
    uint64 internal constant SEPOLIA_ATTESTED = 11_690_000;

    WCTC internal wctc;
    CovenantPool internal pool;
    CreditRecord internal record;
    CovenantManagerHarness internal manager;
    MockNativeQueryVerifier internal verifier = MockNativeQueryVerifier(VERIFIER_ADDR);
    MockChainInfo internal chainInfo = MockChainInfo(CHAIN_INFO_ADDR);

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal borrower = makeAddr("borrower");
    address internal reporter = makeAddr("reporter");
    address internal keeper = makeAddr("keeper");
    uint256 internal walletPk = 0xA11CE;
    address internal wallet = vm.addr(0xA11CE);

    uint256 internal constant LP_DEPOSIT = 10_000 ether;
    uint256 internal constant BOND = 100 ether;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        vm.etch(VERIFIER_ADDR, address(new MockNativeQueryVerifier()).code);
        vm.etch(CHAIN_INFO_ADDR, address(new MockChainInfo()).code);
        chainInfo.setLatest(MAINNET, MAINNET_ATTESTED);
        chainInfo.setLatest(SEPOLIA, SEPOLIA_ATTESTED);

        wctc = new WCTC();
        pool = new CovenantPool(IERC20(address(wctc)), owner);
        record = new CreditRecord(owner);
        manager = new CovenantManagerHarness(IERC20(address(wctc)), pool, record, owner);

        vm.startPrank(owner);
        pool.setManager(address(manager));
        record.setManager(address(manager));
        manager.setAavePool(MAINNET, AAVE_MAINNET);
        manager.setAavePool(SEPOLIA, AAVE_SEPOLIA);
        manager.setPledgeToken(MAINNET, USDC_MAINNET, true);
        manager.setPledgeToken(SEPOLIA, USDC_SEPOLIA, true);
        vm.stopPrank();

        _wrap(lp, LP_DEPOSIT);
        vm.startPrank(lp);
        wctc.approve(address(pool), type(uint256).max);
        pool.deposit(LP_DEPOSIT, lp);
        vm.stopPrank();

        _wrap(borrower, 1000 ether);
        vm.prank(borrower);
        wctc.approve(address(manager), type(uint256).max);
    }

    // ------------------------------------------------------------------ funding

    function _wrap(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        wctc.deposit{value: amount}();
    }

    // ------------------------------------------------------------------ terms

    function _term(uint8 kind, uint64 chainKey, address target, uint256 threshold) internal pure returns (Term memory) {
        return Term({kind: kind, chainKey: chainKey, target: target, threshold: threshold, retired: false});
    }

    function _terms1(Term memory a) internal pure returns (Term[] memory t) {
        t = new Term[](1);
        t[0] = a;
    }

    function _terms3(Term memory a, Term memory b, Term memory c) internal pure returns (Term[] memory t) {
        t = new Term[](3);
        (t[0], t[1], t[2]) = (a, b, c);
    }

    /// @dev CROSS_DEFAULT(mainnet), DEBT_CAP(mainnet USDC > 1000e6), NEGATIVE_PLEDGE(mainnet USDC > 500e6).
    function _standardTerms() internal pure returns (Term[] memory) {
        return _terms3(
            _term(CROSS_DEFAULT, MAINNET, address(0), 0),
            _term(DEBT_CAP, MAINNET, USDC_MAINNET, 1000e6),
            _term(NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 500e6)
        );
    }

    // ------------------------------------------------------------------ signatures

    function _sign(uint256 pk, address borrower_, address wallet_, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = manager.linkWalletDigest(borrower_, wallet_, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _open(Term[] memory terms, uint256 bond) internal returns (uint256 lineId) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(walletPk, borrower, wallet, manager.nonces(wallet), deadline);
        vm.prank(borrower);
        lineId = manager.openLine(terms, bond, wallet, deadline, sig, keccak256("memo"));
    }

    function _openStandard() internal returns (uint256) {
        return _open(_standardTerms(), BOND);
    }

    // ------------------------------------------------------------------ proofs

    /// @dev Merkle proof whose sibling path encodes leaf index `txIndex` (mock precompile semantics).
    function _merkle(uint64 txIndex) internal pure returns (INativeQueryVerifier.MerkleProof memory m) {
        m.root = keccak256(abi.encode("root", txIndex));
        m.siblings = new INativeQueryVerifier.MerkleProofEntry[](8);
        for (uint256 i; i < 8; ++i) {
            m.siblings[i] = INativeQueryVerifier.MerkleProofEntry({
                hash: keccak256(abi.encode(i, txIndex)), isLeft: (txIndex >> i) & 1 == 1
            });
        }
    }

    function _continuity() internal pure returns (INativeQueryVerifier.ContinuityProof memory c) {
        c.lowerEndpointDigest = keccak256("lower");
        c.roots = new bytes32[](2);
        c.roots[0] = keccak256("r0");
        c.roots[1] = keccak256("r1");
    }

    function _report(uint256 lineId, uint8 termIndex, uint64 height, bytes memory txb, uint64 txIndex, uint256 logIndex)
        internal
        returns (bytes32)
    {
        vm.prank(reporter);
        return manager.reportBreach(lineId, termIndex, height, txb, _merkle(txIndex), _continuity(), logIndex);
    }

    function _liquidationTx(address user) internal pure returns (bytes memory) {
        return TxBuilder.encode(TxBuilder.liquidation(AAVE_MAINNET, user, 4000e6));
    }

    function _line(uint256 lineId) internal view returns (Line memory) {
        return manager.lineOf(lineId);
    }

    function _replayKey(uint64 chainKey, uint64 height, uint64 txIndex, uint256 logIndex) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainKey, height, txIndex, logIndex));
    }
}
