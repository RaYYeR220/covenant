// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {WCTC} from "../src/WCTC.sol";
import {CovenantPool} from "../src/CovenantPool.sol";

contract CovenantPoolTest is Test {
    WCTC internal wctc;
    CovenantPool internal pool;

    address internal owner = makeAddr("owner");
    address internal manager = makeAddr("manager");
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    address internal borrower = makeAddr("borrower");

    function setUp() public {
        wctc = new WCTC();
        pool = new CovenantPool(IERC20(address(wctc)), owner);
        vm.prank(owner);
        pool.setManager(manager);
    }

    function _fund(address who, uint256 amount) internal {
        vm.deal(who, amount);
        vm.startPrank(who);
        wctc.deposit{value: amount}();
        wctc.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _fund(who, amount);
        vm.prank(who);
        shares = pool.deposit(amount, who);
    }

    // ---------------------------------------------------------------- config

    function test_metadataAndDefaults() public view {
        assertEq(pool.asset(), address(wctc));
        assertEq(pool.decimals(), 24); // 18 asset decimals + 6 virtual offset
        assertEq(pool.maxUtilizationBps(), 8000);
        assertEq(pool.manager(), manager);
        assertEq(pool.owner(), owner);
    }

    function test_setManager_onlyOnce() public {
        vm.prank(owner);
        vm.expectRevert(CovenantPool.ManagerAlreadySet.selector);
        pool.setManager(address(0xBEEF));
    }

    function test_setManager_onlyOwner() public {
        CovenantPool fresh = new CovenantPool(IERC20(address(wctc)), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fresh.setManager(manager);
    }

    function test_setManager_rejectsZero() public {
        CovenantPool fresh = new CovenantPool(IERC20(address(wctc)), owner);
        vm.prank(owner);
        vm.expectRevert(CovenantPool.ZeroAddress.selector);
        fresh.setManager(address(0));
    }

    function test_setMaxUtilization_bounded() public {
        vm.startPrank(owner);
        pool.setMaxUtilizationBps(9500);
        assertEq(pool.maxUtilizationBps(), 9500);
        vm.expectRevert(CovenantPool.ParameterOutOfBounds.selector);
        pool.setMaxUtilizationBps(9501);
        vm.expectRevert(CovenantPool.ParameterOutOfBounds.selector);
        pool.setMaxUtilizationBps(999);
        vm.stopPrank();
    }

    function test_setMaxUtilization_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        pool.setMaxUtilizationBps(5000);
    }

    function test_ownershipIsTwoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        pool.transferOwnership(next);
        assertEq(pool.owner(), owner);
        vm.prank(next);
        pool.acceptOwnership();
        assertEq(pool.owner(), next);
    }

    // ---------------------------------------------------------------- access control

    function test_lend_onlyManager() public {
        _deposit(lp, 100 ether);
        vm.expectRevert(CovenantPool.NotManager.selector);
        pool.lend(borrower, 1 ether);
    }

    function test_onRepay_onlyManager() public {
        vm.expectRevert(CovenantPool.NotManager.selector);
        pool.onRepay(0, 0);
    }

    function test_writeOff_onlyManager() public {
        vm.expectRevert(CovenantPool.NotManager.selector);
        pool.writeOff(0);
    }

    function test_ownerCannotLend() public {
        _deposit(lp, 100 ether);
        vm.prank(owner);
        vm.expectRevert(CovenantPool.NotManager.selector);
        pool.lend(owner, 1 ether);
    }

    // ---------------------------------------------------------------- lending

    function test_lend_movesIdleToOutstanding() public {
        _deposit(lp, 100 ether);
        vm.prank(manager);
        pool.lend(borrower, 30 ether);

        assertEq(wctc.balanceOf(borrower), 30 ether);
        assertEq(pool.outstandingPrincipal(), 30 ether);
        assertEq(pool.idleAssets(), 70 ether);
        assertEq(pool.totalAssets(), 100 ether);
    }

    function test_lend_utilizationCapReached() public {
        _deposit(lp, 100 ether);
        vm.startPrank(manager);
        pool.lend(borrower, 80 ether);
        vm.expectRevert(CovenantPool.UtilizationCapExceeded.selector);
        pool.lend(borrower, 1);
        vm.stopPrank();
    }

    function test_lend_utilizationCapSingleDraw() public {
        _deposit(lp, 100 ether);
        vm.prank(manager);
        vm.expectRevert(CovenantPool.UtilizationCapExceeded.selector);
        pool.lend(borrower, 80 ether + 1);
    }

    function test_lend_rejectsZero() public {
        _deposit(lp, 100 ether);
        vm.prank(manager);
        vm.expectRevert(CovenantPool.ZeroAmount.selector);
        pool.lend(borrower, 0);
    }

    function test_withdraw_beyondIdleReverts() public {
        _deposit(lp, 100 ether);
        vm.prank(manager);
        pool.lend(borrower, 80 ether);

        assertEq(pool.maxWithdraw(lp), 20 ether);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, 21 ether, 20 ether));
        pool.withdraw(21 ether, lp, lp);

        vm.prank(lp);
        pool.withdraw(20 ether, lp, lp);
        assertEq(wctc.balanceOf(lp), 20 ether);
    }

    function test_redeem_beyondIdleReverts() public {
        uint256 shares = _deposit(lp, 100 ether);
        vm.prank(manager);
        pool.lend(borrower, 50 ether);

        uint256 maxShares = pool.maxRedeem(lp);
        assertLt(maxShares, shares);
        assertApproxEqAbs(pool.previewRedeem(maxShares), 50 ether, 1);

        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp, shares, maxShares)
        );
        pool.redeem(shares, lp, lp);
    }

    function test_maxWithdraw_ownerBalanceBelowIdle() public {
        _deposit(lp, 10 ether);
        _deposit(lp2, 90 ether);
        vm.prank(manager);
        pool.lend(borrower, 50 ether);
        assertEq(pool.maxWithdraw(lp), 10 ether);
        assertEq(pool.maxWithdraw(lp2), 50 ether);
    }

    // ---------------------------------------------------------------- repay / write-off

    function test_onRepay_interestRaisesSharePrice() public {
        uint256 shares = _deposit(lp, 100 ether);
        vm.prank(manager);
        pool.lend(manager, 50 ether);

        // manager pushes principal + interest back first, then books it
        vm.startPrank(manager);
        vm.deal(manager, 10 ether);
        wctc.deposit{value: 10 ether}();
        wctc.transfer(address(pool), 60 ether);
        pool.onRepay(50 ether, 10 ether);
        vm.stopPrank();

        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.totalAssets(), 110 ether);
        assertApproxEqAbs(pool.previewRedeem(shares), 110 ether, 1);
    }

    function test_onRepay_rejectsPrincipalAboveOutstanding() public {
        _deposit(lp, 100 ether);
        vm.prank(manager);
        pool.lend(borrower, 10 ether);
        vm.prank(manager);
        vm.expectRevert(CovenantPool.ExceedsOutstanding.selector);
        pool.onRepay(10 ether + 1, 0);
    }

    function test_writeOff_socializesLoss() public {
        uint256 shares = _deposit(lp, 100 ether);
        vm.startPrank(manager);
        pool.lend(borrower, 40 ether);
        pool.writeOff(40 ether);
        vm.stopPrank();

        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.totalAssets(), 60 ether);
        assertApproxEqAbs(pool.previewRedeem(shares), 60 ether, 1);
    }

    function test_writeOff_rejectsAboveOutstanding() public {
        _deposit(lp, 100 ether);
        vm.prank(manager);
        pool.lend(borrower, 10 ether);
        vm.prank(manager);
        vm.expectRevert(CovenantPool.ExceedsOutstanding.selector);
        pool.writeOff(10 ether + 1);
    }

    // ---------------------------------------------------------------- ERC-4626 safety

    function test_inflationAttack_unprofitable() public {
        // attacker seeds 1 wei and donates a large amount to skew the price
        address attacker = makeAddr("attacker");
        _deposit(attacker, 1);
        _fund(attacker, 10 ether);
        vm.prank(attacker);
        wctc.transfer(address(pool), 10 ether);

        uint256 victimShares = _deposit(lp, 10 ether);
        assertGt(victimShares, 0);

        // victim keeps (almost) everything, attacker cannot extract the victim's deposit
        assertApproxEqRel(pool.previewRedeem(victimShares), 10 ether, 1e12); // within 0.0001%
        uint256 attackerShares = pool.balanceOf(attacker);
        assertLt(pool.previewRedeem(attackerShares), 10 ether + 1);
    }

    function testFuzz_depositRedeem_neverProfits(uint96 a, uint96 b, uint96 donation) public {
        vm.assume(a > 0 && b > 0);
        _deposit(lp, a);
        if (donation > 0) {
            _fund(lp2, donation);
            vm.prank(lp2);
            wctc.transfer(address(pool), donation);
        }
        _fund(borrower, b);
        vm.startPrank(borrower);
        uint256 shares = pool.deposit(b, borrower);
        uint256 out = pool.redeem(shares, borrower, borrower);
        vm.stopPrank();
        assertLe(out, b);
    }

    function testFuzz_mintWithdraw_roundsForPool(uint96 assets) public {
        vm.assume(assets > 1);
        _deposit(lp, 50 ether);
        _fund(borrower, uint256(assets) * 2);
        vm.startPrank(borrower);
        uint256 shares = pool.previewDeposit(assets);
        uint256 paid = pool.mint(shares, borrower);
        assertLe(paid, assets);
        uint256 burned = pool.withdraw(paid, borrower, borrower);
        assertLe(burned, shares);
        vm.stopPrank();
    }

    function testFuzz_totalAssetsIsIdlePlusOutstanding(uint96 dep, uint96 lendAmt, uint96 loss) public {
        vm.assume(dep > 0);
        _deposit(lp, dep);
        uint256 cap = uint256(dep) * 8000 / 10_000;
        uint256 l = bound(lendAmt, 0, cap);
        if (l > 0) {
            vm.prank(manager);
            pool.lend(borrower, l);
        }
        uint256 w = bound(loss, 0, l);
        if (w > 0) {
            vm.prank(manager);
            pool.writeOff(w);
        }
        assertEq(pool.totalAssets(), wctc.balanceOf(address(pool)) + pool.outstandingPrincipal());
        assertEq(pool.outstandingPrincipal(), l - w);
    }

    function testFuzz_conversionRoundTripNeverInflates(uint96 dep, uint96 x) public {
        vm.assume(dep > 0);
        _deposit(lp, dep);
        IERC4626 v = IERC4626(address(pool));
        assertLe(v.convertToAssets(v.convertToShares(x)), x);
    }
}
