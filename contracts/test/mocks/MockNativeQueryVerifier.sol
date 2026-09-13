// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev Stand-in for the Native Query Verifier precompile. Etched at 0x0FD2 in tests.
///      Storage lives at the etched address, so configure it through the precompile address.
contract MockNativeQueryVerifier {
    event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);

    bool public fail;
    bool public revertOnVerify;
    uint256 public singleCalls;
    uint256 public batchCalls;

    function setFail(bool fail_) external {
        fail = fail_;
    }

    function setRevert(bool revert_) external {
        revertOnVerify = revert_;
    }

    /// @dev Leaf index from the sibling path: bit i is set when sibling i sits on the left.
    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata merkleProof) public pure returns (uint64 idx) {
        uint256 n = merkleProof.siblings.length;
        for (uint256 i; i < n; ++i) {
            if (merkleProof.siblings[i].isLeft) idx |= uint64(1) << uint64(i);
        }
    }

    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata
    ) external returns (bool) {
        if (revertOnVerify) revert("verifier: bad proof");
        singleCalls++;
        if (fail) return false;
        emit TransactionVerified(chainKey, height, calculateTxIndex(merkleProof));
        return true;
    }

    function verifyAndEmit(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        INativeQueryVerifier.ContinuityProof calldata
    ) external returns (bool) {
        if (revertOnVerify) revert("verifier: bad proof");
        require(heights.length == encodedTransactions.length && heights.length == merkleProofs.length, "len");
        batchCalls++;
        if (fail) return false;
        for (uint256 i; i < heights.length; ++i) {
            emit TransactionVerified(chainKey, heights[i], calculateTxIndex(merkleProofs[i]));
        }
        return true;
    }

    function verify(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external view returns (bool) {
        if (revertOnVerify) revert("verifier: bad proof");
        return !fail;
    }

    function verify(
        uint64,
        uint64[] calldata,
        bytes[] calldata,
        INativeQueryVerifier.MerkleProof[] calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external view returns (bool) {
        if (revertOnVerify) revert("verifier: bad proof");
        return !fail;
    }
}
