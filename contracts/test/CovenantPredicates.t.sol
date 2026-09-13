// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {CovenantPredicates} from "../src/libraries/CovenantPredicates.sol";
import {CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "../src/libraries/Types.sol";
import {TxBuilder} from "./utils/TxBuilder.sol";

/// @dev Exposes the internal library so reverts and return values can be asserted externally.
contract PredicatesHarness {
    function breach(uint8 kind, address emitter, address target, uint256 threshold, address wallet, bytes memory txb, uint256 idx)
        external
        pure
        returns (CovenantPredicates.Reason reason, uint256 amount, address asset)
    {
        EvmV1Decoder.LogEntry memory log;
        (reason, log) = CovenantPredicates.logAt(txb, idx);
        if (reason != CovenantPredicates.Reason.Ok) return (reason, 0, address(0));
        return CovenantPredicates.matchBreach(kind, emitter, target, threshold, wallet, log);
    }

    function repay(address pool, address wallet, address reserve, uint256 minAmount, bytes memory txb, uint256 idx)
        external
        pure
        returns (CovenantPredicates.Reason reason, uint256 amount)
    {
        EvmV1Decoder.LogEntry memory log;
        (reason, log) = CovenantPredicates.logAt(txb, idx);
        if (reason != CovenantPredicates.Reason.Ok) return (reason, 0);
        return CovenantPredicates.matchRepay(log, pool, wallet, reserve, minAmount);
    }

    function transferTo(address token, address wallet, uint256 minAmount, bytes memory txb, uint256 idx)
        external
        pure
        returns (CovenantPredicates.Reason reason, uint256 amount)
    {
        EvmV1Decoder.LogEntry memory log;
        (reason, log) = CovenantPredicates.logAt(txb, idx);
        if (reason != CovenantPredicates.Reason.Ok) return (reason, 0);
        return CovenantPredicates.matchTransferTo(log, token, wallet, minAmount);
    }

    function describe(CovenantPredicates.Reason r) external pure returns (string memory) {
        return CovenantPredicates.describe(r);
    }
}

contract CovenantPredicatesTest is Test {
    using TxBuilder for EvmV1Decoder.LogEntryTuple;

    PredicatesHarness internal h;

    address internal constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal wallet = makeAddr("wallet");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        h = new PredicatesHarness();
    }

    function _assertReason(CovenantPredicates.Reason got, CovenantPredicates.Reason want) internal pure {
        assertEq(uint8(got), uint8(want), "reason");
    }

    // ------------------------------------------------------------ CROSS_DEFAULT

    function test_crossDefault_matches() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(AAVE, wallet, 1234));
        (CovenantPredicates.Reason r, uint256 amount,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.Ok);
        assertEq(amount, 1234);
    }

    function test_crossDefault_wrongWallet() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(AAVE, attacker, 1234));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongWallet);
    }

    function test_crossDefault_spoofedEmitter() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(attacker, wallet, 1234));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongEmitter);
    }

    function test_crossDefault_wrongEventFromPool() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, USDC, wallet, 1234));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongEvent);
    }

    function test_crossDefault_malformedTopics() public view {
        EvmV1Decoder.LogEntryTuple memory log = TxBuilder.liquidation(AAVE, wallet, 1234);
        bytes32[] memory topics = new bytes32[](3);
        (topics[0], topics[1], topics[2]) = (log.topics[0], log.topics[1], log.topics[3]);
        log.topics = topics;
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, TxBuilder.encode(log), 0);
        _assertReason(r, CovenantPredicates.Reason.MalformedLog);
    }

    function test_crossDefault_malformedData() public view {
        EvmV1Decoder.LogEntryTuple memory log = TxBuilder.liquidation(AAVE, wallet, 1234);
        log.data = abi.encode(uint256(1234));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, TxBuilder.encode(log), 0);
        _assertReason(r, CovenantPredicates.Reason.MalformedLog);
    }

    function test_dirtyAddressTopicRejected() public view {
        EvmV1Decoder.LogEntryTuple memory log = TxBuilder.liquidation(AAVE, wallet, 1234);
        log.topics[3] = bytes32(uint256(uint160(wallet)) | (uint256(1) << 200));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, TxBuilder.encode(log), 0);
        _assertReason(r, CovenantPredicates.Reason.MalformedLog);
    }

    // ------------------------------------------------------------ DEBT_CAP

    function test_debtCap_matchesAboveThreshold() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, USDC, wallet, 1001));
        (CovenantPredicates.Reason r, uint256 amount, address asset) =
            h.breach(DEBT_CAP, AAVE, USDC, 1000, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.Ok);
        assertEq(amount, 1001);
        assertEq(asset, USDC);
    }

    function test_debtCap_thresholdNotExceeded() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, USDC, wallet, 1000));
        (CovenantPredicates.Reason r,,) = h.breach(DEBT_CAP, AAVE, USDC, 1000, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.ThresholdNotExceeded);
    }

    function test_debtCap_wrongReserve() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, WETH, wallet, 5000));
        (CovenantPredicates.Reason r,,) = h.breach(DEBT_CAP, AAVE, USDC, 1000, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongAsset);
    }

    function test_debtCap_anyReserveWhenTargetZero() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, WETH, wallet, 5000));
        (CovenantPredicates.Reason r,, address asset) = h.breach(DEBT_CAP, AAVE, address(0), 1000, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.Ok);
        assertEq(asset, WETH);
    }

    function test_debtCap_wrongWallet() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, USDC, attacker, 5000));
        (CovenantPredicates.Reason r,,) = h.breach(DEBT_CAP, AAVE, USDC, 1000, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongWallet);
    }

    function test_debtCap_spoofedEmitter() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(attacker, USDC, wallet, 5000));
        (CovenantPredicates.Reason r,,) = h.breach(DEBT_CAP, AAVE, USDC, 1000, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongEmitter);
    }

    // ------------------------------------------------------------ NEGATIVE_PLEDGE

    function test_pledge_matchesOutgoingTransfer() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.transfer(USDC, wallet, attacker, 501));
        (CovenantPredicates.Reason r, uint256 amount, address asset) =
            h.breach(NEGATIVE_PLEDGE, USDC, USDC, 500, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.Ok);
        assertEq(amount, 501);
        assertEq(asset, USDC);
    }

    function test_pledge_incomingTransferIsNotBreach() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.transfer(USDC, attacker, wallet, 501));
        (CovenantPredicates.Reason r,,) = h.breach(NEGATIVE_PLEDGE, USDC, USDC, 500, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongWallet);
    }

    function test_pledge_spoofedToken() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.transfer(attacker, wallet, attacker, 501));
        (CovenantPredicates.Reason r,,) = h.breach(NEGATIVE_PLEDGE, USDC, USDC, 500, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongEmitter);
    }

    function test_pledge_thresholdNotExceeded() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.transfer(USDC, wallet, attacker, 500));
        (CovenantPredicates.Reason r,,) = h.breach(NEGATIVE_PLEDGE, USDC, USDC, 500, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.ThresholdNotExceeded);
    }

    // ------------------------------------------------------------ receipt / bounds

    function test_failedReceiptRejected() public view {
        bytes memory txb = TxBuilder.encode(0, TxBuilder.one(TxBuilder.liquidation(AAVE, wallet, 1)));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.ReceiptFailed);
    }

    function test_logIndexOutOfBounds() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(AAVE, wallet, 1));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 1);
        _assertReason(r, CovenantPredicates.Reason.LogIndexOutOfBounds);
    }

    function test_unknownKind() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(AAVE, wallet, 1));
        (CovenantPredicates.Reason r,,) = h.breach(3, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.UnknownKind);
    }

    function test_emptyBytesRevertInDecoder() public {
        vm.expectRevert(bytes("EvmV1Decoder: Empty"));
        h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, "", 0);
    }

    // ------------------------------------------------------------ cure / history predicates

    function test_repay_matches() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.repay(AAVE, USDC, wallet, 900));
        (CovenantPredicates.Reason r, uint256 amount) = h.repay(AAVE, wallet, USDC, 900, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.Ok);
        assertEq(amount, 900);
    }

    function test_repay_amountTooLow() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.repay(AAVE, USDC, wallet, 899));
        (CovenantPredicates.Reason r,) = h.repay(AAVE, wallet, USDC, 900, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.AmountTooLow);
    }

    function test_repay_wrongReserve() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.repay(AAVE, WETH, wallet, 900));
        (CovenantPredicates.Reason r,) = h.repay(AAVE, wallet, USDC, 0, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongAsset);
    }

    function test_repay_wrongUserAndEmitter() public view {
        (CovenantPredicates.Reason r,) =
            h.repay(AAVE, wallet, address(0), 0, TxBuilder.encode(TxBuilder.repay(AAVE, USDC, attacker, 1)), 0);
        _assertReason(r, CovenantPredicates.Reason.WrongWallet);
        (r,) = h.repay(AAVE, wallet, address(0), 0, TxBuilder.encode(TxBuilder.repay(attacker, USDC, wallet, 1)), 0);
        _assertReason(r, CovenantPredicates.Reason.WrongEmitter);
    }

    function test_transferTo_matchesAndChecksAmount() public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.transfer(USDC, attacker, wallet, 700));
        (CovenantPredicates.Reason r, uint256 amount) = h.transferTo(USDC, wallet, 700, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.Ok);
        assertEq(amount, 700);
        (r,) = h.transferTo(USDC, wallet, 701, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.AmountTooLow);
        (r,) = h.transferTo(USDC, attacker, 0, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongWallet);
    }

    function test_describe() public view {
        assertEq(h.describe(CovenantPredicates.Reason.Ok), "");
        assertEq(h.describe(CovenantPredicates.Reason.WrongEmitter), "wrong emitter");
        assertEq(h.describe(CovenantPredicates.Reason.WrongWallet), "wrong wallet");
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_liquidationOnlyMatchesLinkedWallet(address user, address linked) public view {
        vm.assume(user != linked);
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(AAVE, user, 1));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, linked, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongWallet);
    }

    function testFuzz_emitterBinding(address emitter) public view {
        vm.assume(emitter != AAVE);
        bytes memory txb = TxBuilder.encode(TxBuilder.liquidation(emitter, wallet, 1));
        (CovenantPredicates.Reason r,,) = h.breach(CROSS_DEFAULT, AAVE, address(0), 0, wallet, txb, 0);
        _assertReason(r, CovenantPredicates.Reason.WrongEmitter);
    }

    function testFuzz_debtCapThreshold(uint256 amount, uint256 threshold) public view {
        bytes memory txb = TxBuilder.encode(TxBuilder.borrow(AAVE, USDC, wallet, amount));
        (CovenantPredicates.Reason r,,) = h.breach(DEBT_CAP, AAVE, USDC, threshold, wallet, txb, 0);
        if (amount > threshold) _assertReason(r, CovenantPredicates.Reason.Ok);
        else _assertReason(r, CovenantPredicates.Reason.ThresholdNotExceeded);
    }
}
