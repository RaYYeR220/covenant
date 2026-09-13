// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {CovenantManager} from "../src/CovenantManager.sol";
import {CovenantPredicates} from "../src/libraries/CovenantPredicates.sol";
import {Line, Status, CROSS_DEFAULT} from "../src/libraries/Types.sol";
import {CovenantBase} from "./utils/CovenantBase.sol";
import {TxBuilder} from "./utils/TxBuilder.sol";

contract CovenantManagerHistoryTest is CovenantBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _open(_terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 0)), BOND); // 2x
    }

    function _repayTx(address user) internal pure returns (bytes memory) {
        return TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, user, 10e6));
    }

    function _batch(uint256 n, address user)
        internal
        pure
        returns (
            uint64[] memory heights,
            bytes[] memory txs,
            INativeQueryVerifier.MerkleProof[] memory proofs,
            uint256[] memory logIndexes
        )
    {
        heights = new uint64[](n);
        txs = new bytes[](n);
        proofs = new INativeQueryVerifier.MerkleProof[](n);
        logIndexes = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            heights[i] = uint64(100 + i); // history may predate activation
            txs[i] = TxBuilder.encode(TxBuilder.repay(AAVE_MAINNET, USDC_MAINNET, user, 10e6 + i));
            proofs[i] = _merkle(uint64(i));
        }
    }

    function test_proveRepay_single() public {
        vm.prank(reporter); // anyone
        manager.proveRepay(id, MAINNET, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
        assertEq(_line(id).historyRepays, 1);
        assertEq(manager.limitOf(id), BOND * 22_500 / 10_000);
        assertTrue(manager.usedReplayKeys(_replayKey(MAINNET, 100, 5, 0)));
    }

    function test_proveHistory_batchUsesBatchOverload() public {
        (uint64[] memory h, bytes[] memory txs, INativeQueryVerifier.MerkleProof[] memory p, uint256[] memory li) =
            _batch(4, wallet);
        manager.proveHistory(id, MAINNET, h, txs, p, _continuity(), li);
        assertEq(_line(id).historyRepays, 4);
        assertEq(verifier.batchCalls(), 1);
        assertEq(verifier.singleCalls(), 0);
        // 1 + 1 + 1.0 history = 3x
        assertEq(manager.limitOf(id), BOND * 3);
    }

    function test_proveHistory_capExceeded() public {
        (uint64[] memory h, bytes[] memory txs, INativeQueryVerifier.MerkleProof[] memory p, uint256[] memory li) =
            _batch(4, wallet);
        manager.proveHistory(id, MAINNET, h, txs, p, _continuity(), li);
        vm.expectRevert(CovenantManager.HistoryCapExceeded.selector);
        manager.proveRepay(id, MAINNET, 999, _repayTx(wallet), _merkle(77), _continuity(), 0);
    }

    function test_proveHistory_duplicateInsideBatch() public {
        (uint64[] memory h, bytes[] memory txs, INativeQueryVerifier.MerkleProof[] memory p, uint256[] memory li) =
            _batch(2, wallet);
        (h[1], txs[1], p[1]) = (h[0], txs[0], p[0]);
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.ProofAlreadyUsed.selector, _replayKey(MAINNET, 100, 0, 0)));
        manager.proveHistory(id, MAINNET, h, txs, p, _continuity(), li);
    }

    function test_proveRepay_replayed() public {
        manager.proveRepay(id, MAINNET, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.ProofAlreadyUsed.selector, _replayKey(MAINNET, 100, 5, 0)));
        manager.proveRepay(id, MAINNET, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
    }

    function test_proveRepay_wrongWallet() public {
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.PredicateFailed.selector, CovenantPredicates.Reason.WrongWallet));
        manager.proveRepay(id, MAINNET, 100, _repayTx(address(0x0DD)), _merkle(5), _continuity(), 0);
    }

    function test_proveRepay_chainNotOnLine() public {
        vm.expectRevert(abi.encodeWithSelector(CovenantManager.SourceNotRegistered.selector, SEPOLIA));
        manager.proveRepay(id, SEPOLIA, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
    }

    function test_proveRepay_verifierFalse() public {
        verifier.setFail(true);
        vm.expectRevert(CovenantManager.ProofInvalid.selector);
        manager.proveRepay(id, MAINNET, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
    }

    function test_proveHistory_lengthMismatch() public {
        (uint64[] memory h, bytes[] memory txs, INativeQueryVerifier.MerkleProof[] memory p,) = _batch(2, wallet);
        vm.expectRevert(CovenantManager.LengthMismatch.selector);
        manager.proveHistory(id, MAINNET, h, txs, p, _continuity(), new uint256[](1));
    }

    function test_proveHistory_emptyBatch() public {
        vm.expectRevert(CovenantManager.LengthMismatch.selector);
        manager.proveHistory(
            id,
            MAINNET,
            new uint64[](0),
            new bytes[](0),
            new INativeQueryVerifier.MerkleProof[](0),
            _continuity(),
            new uint256[](0)
        );
    }

    function test_proveRepay_inactiveLine() public {
        vm.prank(borrower);
        manager.closeLine(id);
        vm.expectRevert(CovenantManager.LineNotActive.selector);
        manager.proveRepay(id, MAINNET, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
    }

    function test_historyCountsIntoCreditRecordOnClose() public {
        manager.proveRepay(id, MAINNET, 100, _repayTx(wallet), _merkle(5), _continuity(), 0);
        vm.prank(borrower);
        manager.closeLine(id);
        assertEq(record.recordOf(wallet).provenRepays, 1);
        assertEq(record.recordOf(wallet).kept, 1);
    }
}
