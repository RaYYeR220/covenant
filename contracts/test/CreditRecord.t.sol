// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreditRecord} from "../src/CreditRecord.sol";
import {ICreditRecord} from "../src/interfaces/ICreditRecord.sol";

contract CreditRecordTest is Test {
    CreditRecord internal record;
    address internal owner = makeAddr("owner");
    address internal manager = makeAddr("manager");
    address internal wallet = makeAddr("wallet");

    event RecordUpdated(address indexed wallet, ICreditRecord.Action indexed action, ICreditRecord.Record record);

    function setUp() public {
        record = new CreditRecord(owner);
        vm.prank(owner);
        record.setManager(manager);
    }

    function test_emptyRecord() public view {
        ICreditRecord.Record memory r = record.recordOf(wallet);
        assertEq(r.kept + r.breaches + r.cures + r.defaults + r.provenRepays, 0);
        assertEq(r.lastUpdate, 0);
    }

    function test_writes_accumulate() public {
        vm.warp(1000);
        vm.startPrank(manager);
        record.recordBreach(wallet);
        record.recordCure(wallet);
        record.recordBreach(wallet);
        record.recordDefault(wallet);
        vm.warp(2000);
        record.recordKept(wallet, 3);
        vm.stopPrank();

        ICreditRecord.Record memory r = record.recordOf(wallet);
        assertEq(r.breaches, 2);
        assertEq(r.cures, 1);
        assertEq(r.defaults, 1);
        assertEq(r.kept, 1);
        assertEq(r.provenRepays, 3);
        assertEq(r.lastUpdate, 2000);
    }

    function test_emitsEventPerWrite() public {
        vm.warp(77);
        ICreditRecord.Record memory expected;
        expected.breaches = 1;
        expected.lastUpdate = 77;
        vm.expectEmit(address(record));
        emit RecordUpdated(wallet, ICreditRecord.Action.Breach, expected);
        vm.prank(manager);
        record.recordBreach(wallet);
    }

    function test_onlyManagerWrites() public {
        vm.expectRevert(CreditRecord.NotManager.selector);
        record.recordBreach(wallet);
        vm.expectRevert(CreditRecord.NotManager.selector);
        record.recordCure(wallet);
        vm.expectRevert(CreditRecord.NotManager.selector);
        record.recordDefault(wallet);
        vm.expectRevert(CreditRecord.NotManager.selector);
        record.recordKept(wallet, 1);
        vm.prank(owner);
        vm.expectRevert(CreditRecord.NotManager.selector);
        record.recordBreach(wallet);
    }

    function test_setManager_once() public {
        vm.prank(owner);
        vm.expectRevert(CreditRecord.ManagerAlreadySet.selector);
        record.setManager(address(1));
    }

    function test_setManager_onlyOwner() public {
        CreditRecord fresh = new CreditRecord(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fresh.setManager(manager);
    }

    function test_setManager_rejectsZero() public {
        CreditRecord fresh = new CreditRecord(owner);
        vm.prank(owner);
        vm.expectRevert(CreditRecord.ZeroAddress.selector);
        fresh.setManager(address(0));
    }
}
