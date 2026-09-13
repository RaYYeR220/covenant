// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @dev Builds prover-format `txBytes` (`abi.encode(uint8 txType, bytes[] chunks)`) around arbitrary logs,
///      so tests exercise the real EvmV1Decoder on synthetic source-chain receipts.
library TxBuilder {
    bytes32 internal constant LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    bytes32 internal constant BORROW = 0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0;
    bytes32 internal constant REPAY = 0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051;
    bytes32 internal constant TRANSFER = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    function t(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function liquidation(address pool, address user, uint256 debtToCover)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = LIQUIDATION_CALL;
        topics[1] = t(address(0xC011));
        topics[2] = t(address(0xDEB7));
        topics[3] = t(user);
        log = EvmV1Decoder.LogEntryTuple({
            address_: pool, topics: topics, data: abi.encode(debtToCover, uint256(1e18), address(0x11C), false)
        });
    }

    function borrow(address pool, address reserve, address onBehalfOf, uint256 amount)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = BORROW;
        topics[1] = t(reserve);
        topics[2] = t(onBehalfOf);
        topics[3] = bytes32(uint256(0)); // referralCode
        log = EvmV1Decoder.LogEntryTuple({
            address_: pool, topics: topics, data: abi.encode(onBehalfOf, amount, uint8(2), uint256(5e25))
        });
    }

    function repay(address pool, address reserve, address user, uint256 amount)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = REPAY;
        topics[1] = t(reserve);
        topics[2] = t(user);
        topics[3] = t(user); // repayer
        log = EvmV1Decoder.LogEntryTuple({address_: pool, topics: topics, data: abi.encode(amount, false)});
    }

    function transfer(address token, address from, address to, uint256 value)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = TRANSFER;
        topics[1] = t(from);
        topics[2] = t(to);
        log = EvmV1Decoder.LogEntryTuple({address_: token, topics: topics, data: abi.encode(value)});
    }

    function one(EvmV1Decoder.LogEntryTuple memory log) internal pure returns (EvmV1Decoder.LogEntryTuple[] memory a) {
        a = new EvmV1Decoder.LogEntryTuple[](1);
        a[0] = log;
    }

    /// @dev Type-2 transaction with the given receipt status and logs.
    function encode(uint8 status, EvmV1Decoder.LogEntryTuple[] memory logs) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = abi.encode(uint64(7), uint64(500_000), address(0xF00), false, address(0xA11), uint256(0), bytes(""));
        chunks[1] = abi.encode(
            uint64(1), uint128(1 gwei), uint128(30 gwei), new EvmV1Decoder.AccessListEntryBytes32[](0), uint8(0),
            bytes32(uint256(1)), bytes32(uint256(2))
        );
        chunks[2] = abi.encode(status, uint64(210_000), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function encode(EvmV1Decoder.LogEntryTuple memory log) internal pure returns (bytes memory) {
        return encode(1, one(log));
    }

    /// @dev Decodes real prover bytes, swaps the emitter of log `index`, and re-encodes. Used to build a
    ///      spoofed-emitter variant of real mainnet data.
    function withEmitter(bytes memory encodedTx, uint256 index, address emitter) internal pure returns (bytes memory) {
        (uint8 txType, bytes[] memory chunks) = abi.decode(encodedTx, (uint8, bytes[]));
        uint256 r = chunks.length - 1;
        (uint8 status, uint64 gasUsed, EvmV1Decoder.LogEntryTuple[] memory logs, bytes memory bloom) =
            abi.decode(chunks[r], (uint8, uint64, EvmV1Decoder.LogEntryTuple[], bytes));
        logs[index].address_ = emitter;
        chunks[r] = abi.encode(status, gasUsed, logs, bloom);
        return abi.encode(txType, chunks);
    }

    /// @dev Same as `withEmitter` but overrides the receipt status.
    function withStatus(bytes memory encodedTx, uint8 newStatus) internal pure returns (bytes memory) {
        (uint8 txType, bytes[] memory chunks) = abi.decode(encodedTx, (uint8, bytes[]));
        uint256 r = chunks.length - 1;
        (, uint64 gasUsed, EvmV1Decoder.LogEntryTuple[] memory logs, bytes memory bloom) =
            abi.decode(chunks[r], (uint8, uint64, EvmV1Decoder.LogEntryTuple[], bytes));
        chunks[r] = abi.encode(newStatus, gasUsed, logs, bloom);
        return abi.encode(txType, chunks);
    }
}
