// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {CovenantManager} from "../src/CovenantManager.sol";
import {CovenantPredicates} from "../src/libraries/CovenantPredicates.sol";
import {Line, Status, CROSS_DEFAULT, NEGATIVE_PLEDGE} from "../src/libraries/Types.sol";
import {CovenantBase} from "./utils/CovenantBase.sol";
import {Fixtures} from "./utils/Fixtures.sol";
import {TxBuilder} from "./utils/TxBuilder.sol";

/// @notice Real Ethereum mainnet data: Aave V3 liquidation tx
///         0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07 (block 25967341, txIndex 69).
///         Only the precompiles are mocked; decoding and predicates run on the prover's real txBytes.
contract MainnetFixtureTest is CovenantBase {
    string internal constant FILE = "mainnet-aave-liquidation.proof.json";
    address internal constant LIQUIDATED = 0xDE092a220313CedE58750434b66D46B5ff494CBB;
    address internal constant LIQUIDATOR_ROUTER = 0x53Cd0b05934FA0C7Dc9bC2341c86f26ed5cef540;
    address internal constant USDC_RECIPIENT = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c;
    uint256 internal constant LIQ_LOG = 16;
    uint256 internal constant DEBT_TO_COVER = 3_985_851_340; // 3,985.85 USDC

    Fixtures.Proof internal fx;

    function setUp() public override {
        super.setUp();
        fx = Fixtures.proof(FILE);
    }

    function test_fixture_metadata() public view {
        assertEq(fx.chainKey, MAINNET);
        assertEq(fx.height, 25_967_341);
        assertEq(fx.txIndex, 69);
        assertEq(fx.txHash, 0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07);
        // the sibling path of the real proof encodes the tx index the prover reported
        assertEq(verifier.calculateTxIndex(fx.merkle), 69);
    }

    function test_realTx_decodesWithEvmV1Decoder() public view {
        Fixtures.Proof memory p = Fixtures.proof(FILE);
        assertEq(EvmV1Decoder.getTransactionType(p.txBytes), 2);
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(p.txBytes);
        assertEq(r.receiptStatus, 1);
        assertEq(r.receiptLogs.length, 68);
        assertEq(r.receiptLogs[LIQ_LOG].address_, AAVE_MAINNET);
        assertEq(r.receiptLogs[LIQ_LOG].topics[0], CovenantPredicates.LIQUIDATION_CALL_TOPIC);
        assertEq(r.receiptLogs[15].address_, USDC_MAINNET);
        assertEq(r.receiptLogs[15].topics[0], CovenantPredicates.TRANSFER_TOPIC);
    }

    // ------------------------------------------------------------ CROSS_DEFAULT on real data

    function test_crossDefault_matchesRealLiquidation() public view {
        (bool breach, uint256 amount, string memory reason) =
            manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, LIQUIDATED, fx.txBytes, LIQ_LOG);
        assertTrue(breach, reason);
        assertEq(amount, DEBT_TO_COVER);
    }

    function test_crossDefault_otherWalletDoesNotMatch() public view {
        (bool breach,, string memory reason) =
            manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, wallet, fx.txBytes, LIQ_LOG);
        assertFalse(breach);
        assertEq(reason, "wrong wallet");
    }

    function testFuzz_crossDefault_onlyLiquidatedWalletMatches(address other) public view {
        vm.assume(other != LIQUIDATED);
        (bool breach,,) = manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, other, fx.txBytes, LIQ_LOG);
        assertFalse(breach);
    }

    function test_spoofedEmitter_realLogFromOtherAddressRejected() public view {
        // identical LiquidationCall topics and data, emitted by a contract that is not the Aave pool
        bytes memory spoofed = TxBuilder.withEmitter(fx.txBytes, LIQ_LOG, address(0xBADBAD));
        (bool breach,, string memory reason) =
            manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, LIQUIDATED, spoofed, LIQ_LOG);
        assertFalse(breach);
        assertEq(reason, "wrong emitter");
    }

    function test_crossDefault_wrongLogIndexOnRealTx() public view {
        (bool breach,, string memory reason) =
            manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, LIQUIDATED, fx.txBytes, 15);
        assertFalse(breach);
        assertEq(reason, "wrong emitter"); // log 15 is a USDC Transfer
        (breach,, reason) = manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, LIQUIDATED, fx.txBytes, 68);
        assertFalse(breach);
        assertEq(reason, "log index out of bounds");
    }

    function test_failedStatusVariantOfRealTxRejected() public view {
        bytes memory reverted = TxBuilder.withStatus(fx.txBytes, 0);
        (bool breach,, string memory reason) =
            manager.previewPredicate(CROSS_DEFAULT, MAINNET, address(0), 0, LIQUIDATED, reverted, LIQ_LOG);
        assertFalse(breach);
        assertEq(reason, "receipt status not success");
    }

    // ------------------------------------------------------------ NEGATIVE_PLEDGE on real USDC transfers

    function test_negativePledge_realUsdcTransfer() public view {
        // log 15: USDC Transfer 0x53cd..f540 -> 0x98c2..6f5c, 3,985.851340 USDC
        (bool breach, uint256 amount, string memory reason) = manager.previewPredicate(
            NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, DEBT_TO_COVER - 1, LIQUIDATOR_ROUTER, fx.txBytes, 15
        );
        assertTrue(breach, reason);
        assertEq(amount, DEBT_TO_COVER);

        (breach,, reason) = manager.previewPredicate(
            NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, DEBT_TO_COVER, LIQUIDATOR_ROUTER, fx.txBytes, 15
        );
        assertFalse(breach);
        assertEq(reason, "threshold not exceeded");

        // the recipient did not pledge anything away
        (breach,, reason) =
            manager.previewPredicate(NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 0, USDC_RECIPIENT, fx.txBytes, 15);
        assertFalse(breach);
        assertEq(reason, "wrong wallet");
    }

    function test_negativePledge_otherRealTransfers() public view {
        // log 17: 0x7bea..c387 -> router, 312.836217 USDC ; log 1: 0xbbbbbbbbbb9c..ffcb -> router, 3,989.836931 USDC
        (bool breach, uint256 amount,) = manager.previewPredicate(
            NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 0, 0x7BeA39867e4169DBe237d55C8242a8f2fcDcc387, fx.txBytes, 17
        );
        assertTrue(breach);
        assertEq(amount, 312_836_217);
        (breach, amount,) = manager.previewPredicate(
            NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 0, 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb, fx.txBytes, 1
        );
        assertTrue(breach);
        assertEq(amount, 3_989_836_931);
    }

    function test_negativePledge_wrongTokenOnRealLog() public {
        vm.prank(owner);
        manager.setPledgeToken(MAINNET, USDC_SEPOLIA, true);
        (bool breach,, string memory reason) =
            manager.previewPredicate(NEGATIVE_PLEDGE, MAINNET, USDC_SEPOLIA, 0, LIQUIDATOR_ROUTER, fx.txBytes, 15);
        assertFalse(breach);
        assertEq(reason, "wrong emitter");
    }

    // ------------------------------------------------------------ end to end with the real proof

    function _openForLiquidatedWallet(uint64 attested) internal returns (uint256 id) {
        chainInfo.setLatest(MAINNET, attested);
        id = manager.openLineUnsigned(
            borrower, _terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 0)), BOND, LIQUIDATED, bytes32(0)
        );
    }

    function test_reportBreach_realMainnetProof() public {
        uint256 id = _openForLiquidatedWallet(fx.height - 1);
        vm.prank(borrower);
        manager.draw(id, 50 ether);

        uint256 g = gasleft();
        vm.prank(reporter);
        bytes32 key = manager.reportBreach(id, 0, fx.height, fx.txBytes, fx.merkle, fx.continuity, LIQ_LOG);
        console.log("reportBreach gas (real 32KB mainnet tx):", g - gasleft());

        assertEq(key, _replayKey(MAINNET, fx.height, 69, LIQ_LOG));
        Line memory l = _line(id);
        assertEq(uint8(l.status), uint8(Status.Breached));
        assertEq(l.breachAmount, DEBT_TO_COVER);
        assertEq(l.breachHeight, fx.height);
        assertEq(wctc.balanceOf(reporter), 10 ether);
        assertEq(record.recordOf(LIQUIDATED).breaches, 1);
    }

    function test_reportBreach_realProofReplayed() public {
        uint256 id = _openForLiquidatedWallet(fx.height - 1);
        vm.prank(reporter);
        manager.reportBreach(id, 0, fx.height, fx.txBytes, fx.merkle, fx.continuity, LIQ_LOG);
        manager.repay(id, 0); // zero-debt line cures by "full repayment"

        // a second CROSS_DEFAULT term cannot exist on this line, so replay on the same proof via preview
        (bool breach,, string memory reason) =
            manager.previewBreach(id, 0, fx.height, fx.txBytes, fx.merkle, fx.continuity, LIQ_LOG);
        assertFalse(breach);
        assertEq(reason, "term retired");
        assertTrue(manager.usedReplayKeys(_replayKey(MAINNET, fx.height, 69, LIQ_LOG)));
    }

    function test_reportBreach_realProofBeforeActivation() public {
        uint256 id = _openForLiquidatedWallet(fx.height); // the liquidation was already attested at open
        vm.prank(reporter);
        vm.expectRevert(CovenantManager.HeightBeforeActivation.selector);
        manager.reportBreach(id, 0, fx.height, fx.txBytes, fx.merkle, fx.continuity, LIQ_LOG);
    }

    function test_reportBreach_realProofWrongWalletReverts() public {
        chainInfo.setLatest(MAINNET, fx.height - 1);
        uint256 id = manager.openLineUnsigned(
            borrower, _terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 0)), BOND, wallet, bytes32(0)
        );
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(CovenantManager.PredicateFailed.selector, CovenantPredicates.Reason.WrongWallet)
        );
        manager.reportBreach(id, 0, fx.height, fx.txBytes, fx.merkle, fx.continuity, LIQ_LOG);
    }
}
