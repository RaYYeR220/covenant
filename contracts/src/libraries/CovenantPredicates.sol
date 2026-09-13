// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

import {CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "./Types.sol";

/// @title CovenantPredicates
/// @notice Log matching for Covenant breaches, cures and history, on top of the Attestcoin EvmV1Decoder.
/// @dev Every predicate binds the emitter first: topic0 alone is spoofable by any contract.
///      Indexed addresses are read as `address(uint160(uint256(topic)))` after checking the upper
///      96 bits are clean. Topic count and data length must match the event ABI exactly.
library CovenantPredicates {
    /// keccak256("LiquidationCall(address,address,address,uint256,uint256,address,bool)")
    bytes32 internal constant LIQUIDATION_CALL_TOPIC =
        0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    /// keccak256("Borrow(address,address,address,uint256,uint8,uint256,uint16)")
    bytes32 internal constant BORROW_TOPIC = 0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0;
    /// keccak256("Repay(address,address,address,uint256,bool)")
    bytes32 internal constant REPAY_TOPIC = 0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051;
    /// keccak256("Transfer(address,address,uint256)")
    bytes32 internal constant TRANSFER_TOPIC = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    enum Reason {
        Ok,
        ReceiptFailed,
        LogIndexOutOfBounds,
        WrongEmitter,
        WrongEvent,
        MalformedLog,
        WrongWallet,
        WrongAsset,
        ThresholdNotExceeded,
        AmountTooLow,
        UnknownKind,
        SourceNotRegistered,
        TokenNotAllowed
    }

    /// @notice Decodes the receipt of prover `txBytes` and returns log `logIndex`.
    /// @dev `logIndex` is the position inside this transaction's receipt, not the block-level log index.
    ///      Reverts (inside the decoder) if `encodedTx` is not a valid EvmV1 encoding.
    function logAt(bytes memory encodedTx, uint256 logIndex)
        internal
        pure
        returns (Reason reason, EvmV1Decoder.LogEntry memory log)
    {
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTx);
        // the precompile proves inclusion, not success: a reverted tx still has a receipt
        if (receipt.receiptStatus != 1) return (Reason.ReceiptFailed, log);
        if (logIndex >= receipt.receiptLogs.length) return (Reason.LogIndexOutOfBounds, log);
        return (Reason.Ok, receipt.receiptLogs[logIndex]);
    }

    /// @notice Evaluates a breach log for a covenant term.
    /// @param kind Term kind.
    /// @param emitter Required log emitter: the Aave pool for CROSS_DEFAULT / DEBT_CAP, the token for NEGATIVE_PLEDGE.
    /// @param target DEBT_CAP reserve filter (0 = any) or NEGATIVE_PLEDGE token.
    /// @param threshold Amount that must be strictly exceeded (DEBT_CAP, NEGATIVE_PLEDGE).
    /// @param wallet Linked wallet the event must concern.
    /// @return reason Ok on match.
    /// @return amount debtToCover / Borrow amount / Transfer value.
    /// @return asset Debt reserve (CROSS_DEFAULT, DEBT_CAP) or token (NEGATIVE_PLEDGE).
    function matchBreach(
        uint8 kind,
        address emitter,
        address target,
        uint256 threshold,
        address wallet,
        EvmV1Decoder.LogEntry memory log
    ) internal pure returns (Reason reason, uint256 amount, address asset) {
        if (kind == CROSS_DEFAULT) return _matchLiquidation(log, emitter, wallet);
        if (kind == DEBT_CAP) return _matchBorrow(log, emitter, wallet, target, threshold);
        if (kind == NEGATIVE_PLEDGE) return _matchTransferFrom(log, emitter, wallet, threshold);
        return (Reason.UnknownKind, 0, address(0));
    }

    /// @notice Aave Repay from `aavePool` for `wallet` (the `user` whose debt was repaid).
    /// @param reserve Required reserve, or 0 for any.
    /// @param minAmount Minimum repaid amount (inclusive).
    function matchRepay(EvmV1Decoder.LogEntry memory log, address aavePool, address wallet, address reserve, uint256 minAmount)
        internal
        pure
        returns (Reason reason, uint256 amount)
    {
        reason = _checkShape(log, aavePool, REPAY_TOPIC, 4, 64);
        if (reason != Reason.Ok) return (reason, 0);
        (bool ok, address logReserve) = _topicAddress(log.topics[1]);
        (bool ok2, address user) = _topicAddress(log.topics[2]);
        if (!ok || !ok2) return (Reason.MalformedLog, 0);
        if (user != wallet) return (Reason.WrongWallet, 0);
        if (reserve != address(0) && logReserve != reserve) return (Reason.WrongAsset, 0);
        (amount,) = abi.decode(log.data, (uint256, uint256));
        if (amount < minAmount) return (Reason.AmountTooLow, amount);
    }

    /// @notice ERC-20 Transfer of `token` into `wallet` of at least `minAmount`.
    function matchTransferTo(EvmV1Decoder.LogEntry memory log, address token, address wallet, uint256 minAmount)
        internal
        pure
        returns (Reason reason, uint256 amount)
    {
        reason = _checkShape(log, token, TRANSFER_TOPIC, 3, 32);
        if (reason != Reason.Ok) return (reason, 0);
        (bool ok, address to) = _topicAddress(log.topics[2]);
        if (!ok) return (Reason.MalformedLog, 0);
        if (to != wallet) return (Reason.WrongWallet, 0);
        amount = abi.decode(log.data, (uint256));
        if (amount < minAmount) return (Reason.AmountTooLow, amount);
    }

    /// @notice Human-readable reason for views and UIs. Empty string for Ok.
    function describe(Reason reason) internal pure returns (string memory) {
        if (reason == Reason.Ok) return "";
        if (reason == Reason.ReceiptFailed) return "receipt status not success";
        if (reason == Reason.LogIndexOutOfBounds) return "log index out of bounds";
        if (reason == Reason.WrongEmitter) return "wrong emitter";
        if (reason == Reason.WrongEvent) return "wrong event";
        if (reason == Reason.MalformedLog) return "malformed log";
        if (reason == Reason.WrongWallet) return "wrong wallet";
        if (reason == Reason.WrongAsset) return "wrong asset";
        if (reason == Reason.ThresholdNotExceeded) return "threshold not exceeded";
        if (reason == Reason.AmountTooLow) return "amount too low";
        if (reason == Reason.UnknownKind) return "unknown covenant kind";
        if (reason == Reason.SourceNotRegistered) return "source not registered";
        return "token not allowed";
    }

    // ------------------------------------------------------------------ internals

    function _matchLiquidation(EvmV1Decoder.LogEntry memory log, address aavePool, address wallet)
        private
        pure
        returns (Reason reason, uint256 debtToCover, address debtAsset)
    {
        reason = _checkShape(log, aavePool, LIQUIDATION_CALL_TOPIC, 4, 128);
        if (reason != Reason.Ok) return (reason, 0, address(0));
        (bool ok, address debt) = _topicAddress(log.topics[2]);
        (bool ok2, address user) = _topicAddress(log.topics[3]);
        if (!ok || !ok2) return (Reason.MalformedLog, 0, address(0));
        if (user != wallet) return (Reason.WrongWallet, 0, address(0));
        (debtToCover,,,) = abi.decode(log.data, (uint256, uint256, uint256, uint256));
        debtAsset = debt;
    }

    function _matchBorrow(
        EvmV1Decoder.LogEntry memory log,
        address aavePool,
        address wallet,
        address reserve,
        uint256 threshold
    ) private pure returns (Reason reason, uint256 amount, address logReserve) {
        reason = _checkShape(log, aavePool, BORROW_TOPIC, 4, 128);
        if (reason != Reason.Ok) return (reason, 0, address(0));
        bool ok;
        bool ok2;
        address onBehalfOf;
        (ok, logReserve) = _topicAddress(log.topics[1]);
        (ok2, onBehalfOf) = _topicAddress(log.topics[2]);
        if (!ok || !ok2) return (Reason.MalformedLog, 0, address(0));
        if (onBehalfOf != wallet) return (Reason.WrongWallet, 0, address(0));
        if (reserve != address(0) && logReserve != reserve) return (Reason.WrongAsset, 0, address(0));
        (, amount,,) = abi.decode(log.data, (uint256, uint256, uint256, uint256));
        if (amount <= threshold) return (Reason.ThresholdNotExceeded, amount, logReserve);
    }

    function _matchTransferFrom(EvmV1Decoder.LogEntry memory log, address token, address wallet, uint256 threshold)
        private
        pure
        returns (Reason reason, uint256 value, address asset)
    {
        reason = _checkShape(log, token, TRANSFER_TOPIC, 3, 32);
        if (reason != Reason.Ok) return (reason, 0, address(0));
        (bool ok, address from) = _topicAddress(log.topics[1]);
        if (!ok) return (Reason.MalformedLog, 0, address(0));
        if (from != wallet) return (Reason.WrongWallet, 0, address(0));
        value = abi.decode(log.data, (uint256));
        if (value <= threshold) return (Reason.ThresholdNotExceeded, value, token);
        asset = token;
    }

    /// @dev Emitter, then topic0, then exact topic count and data length.
    function _checkShape(
        EvmV1Decoder.LogEntry memory log,
        address emitter,
        bytes32 topic0,
        uint256 topicCount,
        uint256 dataLength
    ) private pure returns (Reason) {
        if (emitter == address(0) || log.address_ != emitter) return Reason.WrongEmitter;
        if (log.topics.length == 0 || log.topics[0] != topic0) return Reason.WrongEvent;
        if (log.topics.length != topicCount || log.data.length != dataLength) return Reason.MalformedLog;
        return Reason.Ok;
    }

    function _topicAddress(bytes32 topic) private pure returns (bool clean, address a) {
        clean = uint256(topic) >> 160 == 0;
        a = address(uint160(uint256(topic)));
    }
}
