// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CovenantManager} from "../src/CovenantManager.sol";
import {CovenantPool} from "../src/CovenantPool.sol";
import {ICreditRecord} from "../src/interfaces/ICreditRecord.sol";
import {Term, Line, Status, CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "../src/libraries/Types.sol";
import {CovenantBase} from "./utils/CovenantBase.sol";

contract CovenantManagerCreditTest is CovenantBase {
    // ------------------------------------------------------------ limit

    function test_limit_standardTerms() public {
        uint256 id = _openStandard();
        // 1x + 1.0 + 0.75 + 0.5 = 3.25x
        assertEq(manager.limitOf(id), BOND * 32_500 / 10_000);
    }

    function test_limit_singleCrossDefault() public {
        uint256 id = _open(_terms1(_term(CROSS_DEFAULT, MAINNET, address(0), 0)), BOND);
        assertEq(manager.limitOf(id), BOND * 2);
    }

    function test_limit_cappedByMaxLeverage() public {
        Term[] memory t = new Term[](4);
        t[0] = _term(CROSS_DEFAULT, MAINNET, address(0), 0);
        t[1] = _term(CROSS_DEFAULT, SEPOLIA, address(0), 0);
        t[2] = _term(DEBT_CAP, MAINNET, USDC_MAINNET, 1);
        t[3] = _term(NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 1);
        uint256 id = _open(t, BOND);
        // 1 + 1 + 1 + 0.75 + 0.5 = 4.25x -> capped at 4x
        assertEq(manager.limitOf(id), BOND * 4);
    }

    function test_limit_sameKindAndChainCountsOnce() public {
        Term[] memory t = new Term[](3);
        t[0] = _term(DEBT_CAP, MAINNET, USDC_MAINNET, 1);
        t[1] = _term(DEBT_CAP, MAINNET, address(0xAAA1), 1);
        t[2] = _term(DEBT_CAP, MAINNET, address(0xAAA2), 1);
        uint256 id = _open(t, BOND);
        assertEq(manager.limitOf(id), BOND * 17_500 / 10_000);
    }

    function test_limit_cappedByPerLineCap() public {
        vm.prank(owner);
        manager.setPerLineCap(150 ether);
        uint256 id = _openStandard();
        assertEq(manager.limitOf(id), 150 ether);
    }

    function test_limit_debtCapAboveLoweredCeilingStopsCounting() public {
        uint256 id = _openStandard();
        vm.prank(owner);
        manager.setMaxDebtCapThreshold(999e6); // below the term's 1000e6
        assertEq(manager.limitOf(id), BOND * 25_000 / 10_000);
    }

    function testFuzz_limitNeverExceedsMaxLeverage(uint96 bond, uint8 mask, uint16 lev) public {
        bond = uint96(bound(bond, 1, 500 ether));
        uint256 maxLev = bound(lev, 10_000, 40_000);
        vm.prank(owner);
        manager.setMaxLeverageBps(maxLev);

        Term[] memory all = new Term[](5);
        all[0] = _term(CROSS_DEFAULT, MAINNET, address(0), 0);
        all[1] = _term(CROSS_DEFAULT, SEPOLIA, address(0), 0);
        all[2] = _term(DEBT_CAP, MAINNET, USDC_MAINNET, 1);
        all[3] = _term(NEGATIVE_PLEDGE, MAINNET, USDC_MAINNET, 1);
        all[4] = _term(NEGATIVE_PLEDGE, SEPOLIA, USDC_SEPOLIA, 1);
        uint256 n;
        for (uint256 i; i < 5; ++i) {
            if (mask & (1 << i) != 0) n++;
        }
        vm.assume(n > 0);
        Term[] memory t = new Term[](n);
        n = 0;
        for (uint256 i; i < 5; ++i) {
            if (mask & (1 << i) != 0) t[n++] = all[i];
        }
        uint256 id = _open(t, bond);
        assertLe(manager.limitOf(id), uint256(bond) * maxLev / 10_000);
    }

    // ------------------------------------------------------------ draw

    function test_draw_lendsFromPool() public {
        uint256 id = _openStandard();
        uint256 before = wctc.balanceOf(borrower);
        vm.prank(borrower);
        manager.draw(id, 200 ether);
        assertEq(wctc.balanceOf(borrower), before + 200 ether);
        assertEq(_line(id).principal, 200 ether);
        assertEq(pool.outstandingPrincipal(), 200 ether);
    }

    function test_draw_overLimit() public {
        uint256 id = _openStandard();
        uint256 limit = manager.limitOf(id);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.ExceedsLimit.selector);
        manager.draw(id, limit + 1);
    }

    function test_draw_cumulativeOverLimit() public {
        uint256 id = _openStandard();
        uint256 limit = manager.limitOf(id);
        vm.startPrank(borrower);
        manager.draw(id, limit);
        vm.expectRevert(CovenantManager.ExceedsLimit.selector);
        manager.draw(id, 1);
        vm.stopPrank();
    }

    function test_draw_onlyBorrower() public {
        uint256 id = _openStandard();
        vm.prank(wallet);
        vm.expectRevert(CovenantManager.NotBorrower.selector);
        manager.draw(id, 1 ether);
    }

    function test_draw_poolUtilizationCap() public {
        // shrink the pool so the line limit is above the pool's 80% cap
        vm.startPrank(lp);
        pool.withdraw(LP_DEPOSIT - 300 ether, lp, lp);
        vm.stopPrank();
        uint256 id = _openStandard(); // limit 325
        vm.prank(borrower);
        vm.expectRevert(CovenantPool.UtilizationCapExceeded.selector);
        manager.draw(id, 241 ether);
        vm.prank(borrower);
        manager.draw(id, 240 ether);
    }

    function test_draw_zero() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.ZeroAmount.selector);
        manager.draw(id, 0);
    }

    // ------------------------------------------------------------ accrual + repay

    function test_accrual_simpleInterestPerSecond() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 100 ether);
        vm.warp(block.timestamp + 365 days);
        // 12% APR on 100
        assertApproxEqAbs(manager.debtOf(id), 112 ether, 1);
    }

    function test_repay_interestFirstThenPrincipal() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 100 ether);
        vm.warp(block.timestamp + 365 days);

        uint256 poolAssetsBefore = pool.totalAssets();
        vm.prank(borrower);
        manager.repay(id, 15 ether);

        Line memory l = _line(id);
        assertEq(l.interestAccrued, 0);
        assertApproxEqAbs(l.principal, 97 ether, 1);
        assertApproxEqAbs(pool.outstandingPrincipal(), 97 ether, 1);
        // interest (12) raises pool assets, principal repayment (3) is neutral
        assertApproxEqAbs(pool.totalAssets(), poolAssetsBefore + 12 ether, 1);
    }

    function test_repay_capsAtDebtAndAnyoneCanPay() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 10 ether);
        _wrap(reporter, 50 ether);
        vm.startPrank(reporter);
        wctc.approve(address(manager), type(uint256).max);
        manager.repay(id, 50 ether);
        vm.stopPrank();
        assertEq(manager.debtOf(id), 0);
        assertEq(wctc.balanceOf(reporter), 40 ether);
        assertEq(pool.outstandingPrincipal(), 0);
    }

    function test_repay_nothingOwed() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.NothingToRepay.selector);
        manager.repay(id, 1 ether);
    }

    function test_repay_frequentAccrualNeverUndercharges() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 1e6); // tiny principal: per-second interest rounds below 1 wei
        uint256 t = block.timestamp;
        for (uint256 i; i < 5; ++i) {
            t += 1; // via-IR may reuse a cached block.timestamp inside one function, so track time locally
            vm.warp(t);
            vm.prank(borrower);
            manager.repay(id, 1);
        }
        // each accrual rounds up, so 5 wei of interest were charged instead of zero
        assertEq(_line(id).principal, 1e6);
    }

    // ------------------------------------------------------------ close

    function test_close_returnsBondAndRecordsKept() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 10 ether);
        vm.warp(block.timestamp + 30 days);
        uint256 debt = manager.debtOf(id);
        vm.startPrank(borrower);
        manager.repay(id, debt);
        uint256 before = wctc.balanceOf(borrower);
        manager.closeLine(id);
        vm.stopPrank();

        assertEq(wctc.balanceOf(borrower), before + BOND);
        assertEq(uint8(_line(id).status), uint8(Status.Closed));
        assertEq(_line(id).bond, 0);
        assertEq(manager.activeLineOf(wallet), 0);
        ICreditRecord.Record memory r = record.recordOf(wallet);
        assertEq(r.kept, 1);
    }

    function test_close_debtOutstanding() public {
        uint256 id = _openStandard();
        vm.prank(borrower);
        manager.draw(id, 10 ether);
        vm.prank(borrower);
        vm.expectRevert(CovenantManager.DebtOutstanding.selector);
        manager.closeLine(id);
    }

    function test_close_onlyBorrower() public {
        uint256 id = _openStandard();
        vm.expectRevert(CovenantManager.NotBorrower.selector);
        manager.closeLine(id);
    }

    function test_close_twice() public {
        uint256 id = _openStandard();
        vm.startPrank(borrower);
        manager.closeLine(id);
        vm.expectRevert(CovenantManager.LineNotActive.selector);
        manager.closeLine(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ params + owner powers

    function test_params_defaults() public view {
        assertEq(manager.aprBps(), 1200);
        assertEq(manager.bountyBps(), 1000);
        assertEq(manager.gracePeriod(), 1 hours);
        assertEq(manager.maxLeverageBps(), 40_000);
    }

    function test_params_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setGracePeriod(10 minutes - 1);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setGracePeriod(30 days + 1);
        manager.setGracePeriod(30 days);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setMaxLeverageBps(40_001);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setMaxLeverageBps(9999);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setAprBps(5001);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setBountyBps(2501);
        vm.expectRevert(CovenantManager.ParameterOutOfBounds.selector);
        manager.setPerLineCap(0);
        vm.stopPrank();
    }

    function test_params_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(err);
        manager.setAprBps(1);
        vm.expectRevert(err);
        manager.setBountyBps(1);
        vm.expectRevert(err);
        manager.setGracePeriod(1 hours);
        vm.expectRevert(err);
        manager.setMaxLeverageBps(20_000);
        vm.expectRevert(err);
        manager.setPerLineCap(1);
        vm.expectRevert(err);
        manager.setMaxDebtCapThreshold(1);
        vm.expectRevert(err);
        manager.setMaxPledgeThreshold(1);
        vm.expectRevert(err);
        manager.setAavePool(MAINNET, address(1));
        vm.expectRevert(err);
        manager.setPledgeToken(MAINNET, address(1), true);
    }

    function test_owner_cannotMoveBondsOrPoolFunds() public {
        uint256 id = _openStandard();
        vm.startPrank(owner);
        vm.expectRevert(CovenantManager.NotBorrower.selector);
        manager.draw(id, 1 ether);
        vm.expectRevert(CovenantManager.NotBorrower.selector);
        manager.closeLine(id);
        vm.expectRevert(CovenantPool.NotManager.selector);
        pool.lend(owner, 1 ether);
        vm.stopPrank();
        assertEq(wctc.balanceOf(address(manager)), BOND);
    }
}
