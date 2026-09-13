// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {CovenantManager} from "../src/CovenantManager.sol";
import {CovenantPredicates} from "../src/libraries/CovenantPredicates.sol";
import {Term, Line, Status, CROSS_DEFAULT, DEBT_CAP} from "../src/libraries/Types.sol";
import {CovenantBase} from "./utils/CovenantBase.sol";
import {Fixtures} from "./utils/Fixtures.sol";

/// @notice Real Ethereum Sepolia data (chainKey 1): four Aave V3 Repay txs and one Borrow by the demo
///         borrower wallet, with single proofs and a batch proof sharing one continuity proof.
contract SepoliaFixtureTest is CovenantBase {
    address internal constant DEMO_WALLET = 0x2E2b283100135De40177e8124bc5591CF69EE163;
    address internal constant TEST_USDC_RESERVE = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    uint256 internal constant REPAY_LOG = 5; // tx-local index inside each repay receipt
    uint256 internal constant BORROW_LOG = 4;

    function _openDemo(Term[] memory terms, uint64 attested) internal returns (uint256) {
        chainInfo.setLatest(SEPOLIA, attested);
        return manager.openLineUnsigned(borrower, terms, BOND, DEMO_WALLET, bytes32(0));
    }

    function _crossDefaultSepolia() internal pure returns (Term[] memory) {
        return _terms1(_term(CROSS_DEFAULT, SEPOLIA, address(0), 0));
    }

    function test_realRepays_decode() public view {
        for (uint256 i = 1; i <= 4; ++i) {
            Fixtures.Proof memory p = Fixtures.proof(string.concat("sepolia-repay-", vm.toString(i), ".proof.json"));
            EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(p.txBytes);
            assertEq(r.receiptStatus, 1);
            EvmV1Decoder.LogEntry memory log = r.receiptLogs[REPAY_LOG];
            assertEq(log.address_, AAVE_SEPOLIA);
            assertEq(log.topics[0], CovenantPredicates.REPAY_TOPIC);
            assertEq(address(uint160(uint256(log.topics[2]))), DEMO_WALLET);
        }
    }

    function test_proveRepay_realSingleProofs() public {
        uint256 id = _openDemo(_crossDefaultSepolia(), 11_698_060);
        uint64[4] memory expectedIdx = [uint64(111), 86, 48, 147];
        for (uint256 i = 1; i <= 4; ++i) {
            Fixtures.Proof memory p = Fixtures.proof(string.concat("sepolia-repay-", vm.toString(i), ".proof.json"));
            assertEq(p.txIndex, expectedIdx[i - 1]);
            manager.proveRepay(id, SEPOLIA, p.height, p.txBytes, p.merkle, p.continuity, REPAY_LOG);
            assertTrue(manager.usedReplayKeys(_replayKey(SEPOLIA, p.height, p.txIndex, REPAY_LOG)));
        }
        assertEq(_line(id).historyRepays, 4);
        assertEq(manager.limitOf(id), BOND * 3);
    }

    function test_proveHistory_realBatchProof() public {
        uint256 id = _openDemo(_crossDefaultSepolia(), 11_698_060);
        Fixtures.Batch memory b = Fixtures.batch("sepolia-repays.batch.json");
        assertEq(b.heights.length, 4);
        assertEq(b.continuity.roots.length, 9);
        assertEq(b.heights[0], 11_698_052);
        assertEq(b.txIndexes[0], 111);

        uint256[] memory logIndexes = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            logIndexes[i] = REPAY_LOG;
        }
        uint256 g = gasleft();
        manager.proveHistory(id, SEPOLIA, b.heights, b.txBytes, b.merkles, b.continuity, logIndexes);
        console.log("proveHistory gas (4 real Sepolia repays, batch):", g - gasleft());

        assertEq(_line(id).historyRepays, 4);
        assertEq(verifier.batchCalls(), 1);
        for (uint256 i; i < 4; ++i) {
            assertTrue(manager.usedReplayKeys(_replayKey(SEPOLIA, b.heights[i], b.txIndexes[i], REPAY_LOG)));
        }
    }

    function test_proveHistory_realBatchWrongLogIndex() public {
        uint256 id = _openDemo(_crossDefaultSepolia(), 11_698_060);
        Fixtures.Batch memory b = Fixtures.batch("sepolia-repays.batch.json");
        uint256[] memory logIndexes = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            logIndexes[i] = REPAY_LOG;
        }
        logIndexes[2] = 2; // ReserveDataUpdated from the same pool
        vm.expectRevert(
            abi.encodeWithSelector(CovenantManager.PredicateFailed.selector, CovenantPredicates.Reason.WrongEvent)
        );
        manager.proveHistory(id, SEPOLIA, b.heights, b.txBytes, b.merkles, b.continuity, logIndexes);
    }

    function test_debtCap_realBorrowPredicate() public view {
        Fixtures.Proof memory p = Fixtures.proof("sepolia-borrow.proof.json");
        (bool breach, uint256 amount, string memory reason) =
            manager.previewPredicate(DEBT_CAP, SEPOLIA, TEST_USDC_RESERVE, 40e6, DEMO_WALLET, p.txBytes, BORROW_LOG);
        assertTrue(breach, reason);
        assertEq(amount, 50e6);

        (breach,, reason) =
            manager.previewPredicate(DEBT_CAP, SEPOLIA, TEST_USDC_RESERVE, 60e6, DEMO_WALLET, p.txBytes, BORROW_LOG);
        assertFalse(breach);
        assertEq(reason, "threshold not exceeded");

        (breach,, reason) =
            manager.previewPredicate(DEBT_CAP, SEPOLIA, USDC_SEPOLIA, 40e6, DEMO_WALLET, p.txBytes, BORROW_LOG);
        assertFalse(breach);
        assertEq(reason, "wrong asset");
    }

    function test_debtCap_realBreachThenRealRepayTooSmallToCure() public {
        Fixtures.Proof memory borrow = Fixtures.proof("sepolia-borrow.proof.json");
        uint256 id = _openDemo(_terms1(_term(DEBT_CAP, SEPOLIA, TEST_USDC_RESERVE, 40e6)), borrow.height - 1);

        vm.prank(reporter);
        manager.reportBreach(id, 0, borrow.height, borrow.txBytes, borrow.merkle, borrow.continuity, BORROW_LOG);
        Line memory l = _line(id);
        assertEq(uint8(l.status), uint8(Status.Breached));
        assertEq(l.breachAmount, 50e6);

        // the real repays are 10 USDC each: not enough to cure a 50 USDC breach
        Fixtures.Proof memory rp = Fixtures.proof("sepolia-repay-1.proof.json");
        vm.expectRevert(
            abi.encodeWithSelector(CovenantManager.PredicateFailed.selector, CovenantPredicates.Reason.AmountTooLow)
        );
        manager.cureByProof(id, rp.height, rp.txBytes, rp.merkle, rp.continuity, REPAY_LOG);
    }
}
