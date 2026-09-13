// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {WCTC} from "../src/WCTC.sol";

contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }

    function unwrap(WCTC token, uint256 amount) external {
        token.withdraw(amount);
    }
}

contract WCTCTest is Test {
    WCTC internal wctc;
    address internal alice = makeAddr("alice");

    function setUp() public {
        wctc = new WCTC();
        vm.deal(alice, 100 ether);
    }

    function test_metadata() public view {
        assertEq(wctc.name(), "Wrapped CTC");
        assertEq(wctc.symbol(), "WCTC");
        assertEq(wctc.decimals(), 18);
    }

    function test_deposit_mintsOneToOne() public {
        vm.prank(alice);
        wctc.deposit{value: 3 ether}();
        assertEq(wctc.balanceOf(alice), 3 ether);
        assertEq(wctc.totalSupply(), 3 ether);
        assertEq(address(wctc).balance, 3 ether);
    }

    function test_receive_wraps() public {
        vm.prank(alice);
        (bool ok,) = address(wctc).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(wctc.balanceOf(alice), 1 ether);
    }

    function test_withdraw_burnsAndSendsNative() public {
        vm.startPrank(alice);
        wctc.deposit{value: 5 ether}();
        wctc.withdraw(2 ether);
        vm.stopPrank();
        assertEq(wctc.balanceOf(alice), 3 ether);
        assertEq(alice.balance, 97 ether);
        assertEq(address(wctc).balance, 3 ether);
    }

    function test_withdraw_revertsBeyondBalance() public {
        vm.prank(alice);
        wctc.deposit{value: 1 ether}();
        vm.prank(alice);
        vm.expectRevert();
        wctc.withdraw(2 ether);
    }

    function test_withdraw_revertsWhenReceiverRejects() public {
        RejectingReceiver r = new RejectingReceiver();
        vm.deal(address(r), 1 ether);
        vm.prank(address(r));
        wctc.deposit{value: 1 ether}();
        vm.expectRevert(WCTC.NativeTransferFailed.selector);
        r.unwrap(wctc, 1 ether);
    }

    function testFuzz_wrapUnwrapRoundTrip(uint96 amount) public {
        vm.deal(alice, amount);
        uint256 before = alice.balance;
        vm.startPrank(alice);
        wctc.deposit{value: amount}();
        wctc.withdraw(amount);
        vm.stopPrank();
        assertEq(alice.balance, before);
        assertEq(wctc.totalSupply(), 0);
    }
}
