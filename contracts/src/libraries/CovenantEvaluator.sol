// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

import {CovenantPredicates} from "./CovenantPredicates.sol";

/// @title CovenantEvaluator
/// @notice Linked (external) library that decodes prover `txBytes` and evaluates Covenant predicates.
/// @dev Split out of CovenantManager to keep the manager under the EIP-170 size limit: the EvmV1Decoder
///      ABI decoding is the bulk of the bytecode. Stateless and pure; `forge script` deploys and links it.
///      `logIndex` is always the tx-local receipt log index.
library CovenantEvaluator {
    /// @notice Breach predicate for a term (see CovenantPredicates.matchBreach).
    function breach(
        uint8 kind,
        address emitter,
        address target,
        uint256 threshold,
        address wallet,
        bytes calldata encodedTx,
        uint256 logIndex
    ) external pure returns (CovenantPredicates.Reason reason, uint256 amount, address asset) {
        EvmV1Decoder.LogEntry memory log;
        (reason, log) = CovenantPredicates.logAt(encodedTx, logIndex);
        if (reason != CovenantPredicates.Reason.Ok) return (reason, 0, address(0));
        return CovenantPredicates.matchBreach(kind, emitter, target, threshold, wallet, log);
    }

    /// @notice Aave Repay predicate (history and DEBT_CAP cure).
    function repay(
        bytes calldata encodedTx,
        uint256 logIndex,
        address aavePool,
        address wallet,
        address reserve,
        uint256 minAmount
    ) external pure returns (CovenantPredicates.Reason reason, uint256 amount) {
        EvmV1Decoder.LogEntry memory log;
        (reason, log) = CovenantPredicates.logAt(encodedTx, logIndex);
        if (reason != CovenantPredicates.Reason.Ok) return (reason, 0);
        return CovenantPredicates.matchRepay(log, aavePool, wallet, reserve, minAmount);
    }

    /// @notice Incoming ERC-20 Transfer predicate (NEGATIVE_PLEDGE cure).
    function transferTo(bytes calldata encodedTx, uint256 logIndex, address token, address wallet, uint256 minAmount)
        external
        pure
        returns (CovenantPredicates.Reason reason, uint256 amount)
    {
        EvmV1Decoder.LogEntry memory log;
        (reason, log) = CovenantPredicates.logAt(encodedTx, logIndex);
        if (reason != CovenantPredicates.Reason.Ok) return (reason, 0);
        return CovenantPredicates.matchTransferTo(log, token, wallet, minAmount);
    }

    /// @notice Human-readable reason.
    function describe(CovenantPredicates.Reason reason) external pure returns (string memory) {
        return CovenantPredicates.describe(reason);
    }
}
