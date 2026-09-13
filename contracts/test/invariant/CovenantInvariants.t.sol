// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

import {WCTC} from "../../src/WCTC.sol";
import {CovenantPool} from "../../src/CovenantPool.sol";
import {Term, Line, Status, CROSS_DEFAULT, NEGATIVE_PLEDGE} from "../../src/libraries/Types.sol";
import {CovenantManagerHarness} from "../harness/CovenantManagerHarness.sol";
import {CovenantBase} from "../utils/CovenantBase.sol";
import {TxBuilder} from "../utils/TxBuilder.sol";

/// @dev Drives random but valid sequences of borrower, LP, reporter and keeper actions.
contract CovenantHandler is Test {
    uint64 internal constant MAINNET = 3;
    address internal constant AAVE_MAINNET = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    CovenantManagerHarness internal manager;
    CovenantPool internal pool;
    WCTC internal wctc;

    uint256[] public lineIds;
    mapping(bytes32 => uint256) public calls;
    uint256[] internal walletKeys;
    uint64 internal nextHeight = 30_000_000;
    uint256 internal time;

    address internal borrower = makeAddr("inv-borrower");
    address internal lp = makeAddr("inv-lp");
    address internal actor = makeAddr("inv-actor");

    constructor(CovenantManagerHarness manager_, CovenantPool pool_, WCTC wctc_) {
        manager = manager_;
        pool = pool_;
        wctc = wctc_;
        for (uint256 i = 1; i <= 5; ++i) {
            walletKeys.push(0xC0FFEE + i);
        }
        time = block.timestamp;
        _wrap(borrower, 1_000_000 ether);
        _wrap(lp, 1_000_000 ether);
        _wrap(actor, 1_000_000 ether);
        vm.prank(borrower);
        wctc.approve(address(manager), type(uint256).max);
        vm.prank(actor);
        wctc.approve(address(manager), type(uint256).max);
        vm.prank(lp);
        wctc.approve(address(pool), type(uint256).max);
    }

    function lineCount() external view returns (uint256) {
        return lineIds.length;
    }

    function _wrap(address who, uint256 amount) internal {
        vm.deal(who, amount);
        vm.prank(who);
        wctc.deposit{value: amount}();
    }

    /// @dev First line at or after a random offset whose status is `want` (Breached also matches when `orBreached`).
    function _pick(uint256 seed, Status want, bool orBreached) internal view returns (uint256 id, Line memory line) {
        uint256 n = lineIds.length;
        for (uint256 k; k < n; ++k) {
            uint256 candidate = lineIds[(seed % n + k) % n];
            Line memory l = manager.lineOf(candidate);
            if (l.status == want || (orBreached && l.status == Status.Breached)) return (candidate, l);
        }
    }

    function _merkle(uint64 idx) internal pure returns (INativeQueryVerifier.MerkleProof memory m) {
        m.siblings = new INativeQueryVerifier.MerkleProofEntry[](1);
        m.siblings[0].isLeft = idx & 1 == 1;
    }

    // ------------------------------------------------------------------ actions

    function lpDeposit(uint256 amount) external {
        amount = bound(amount, 1 ether, 50_000 ether);
        vm.prank(lp);
        pool.deposit(amount, lp);
    }

    function lpWithdraw(uint256 amount) external {
        amount = bound(amount, 0, pool.maxWithdraw(lp));
        if (amount == 0) return;
        vm.prank(lp);
        pool.withdraw(amount, lp, lp);
    }

    function open(uint256 walletSeed, uint256 bond, bool withPledge) external {
        uint256 pk = walletKeys[walletSeed % walletKeys.length];
        address wallet = vm.addr(pk);
        if (manager.activeLineOf(wallet) != 0) return;
        bond = bound(bond, 1 ether, 2000 ether);
        Term[] memory t = new Term[](withPledge ? 2 : 1);
        t[0] = Term({kind: CROSS_DEFAULT, chainKey: MAINNET, target: address(0), threshold: 0, retired: false});
        if (withPledge) {
            t[1] = Term({kind: NEGATIVE_PLEDGE, chainKey: MAINNET, target: USDC_MAINNET, threshold: 1e6, retired: false});
        }
        uint256 deadline = time + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, manager.linkWalletDigest(borrower, wallet, manager.nonces(wallet), deadline));
        vm.prank(borrower);
        lineIds.push(manager.openLine(t, bond, wallet, deadline, abi.encodePacked(r, s, v), bytes32(0)));
        calls["open"]++;
    }

    function draw(uint256 seed, uint256 amount) external {
        (uint256 id, Line memory line) = _pick(seed, Status.Active, false);
        if (id == 0 || line.status != Status.Active) return;
        uint256 limit = manager.limitOf(id);
        if (limit <= line.principal) return;
        uint256 poolRoom = pool.totalAssets() * pool.maxUtilizationBps() / 10_000;
        if (poolRoom <= pool.outstandingPrincipal()) return;
        uint256 max = limit - line.principal;
        uint256 room = poolRoom - pool.outstandingPrincipal();
        if (room < max) max = room;
        if (pool.idleAssets() < max) max = pool.idleAssets();
        amount = bound(amount, 0, max);
        if (amount == 0) return;
        vm.prank(borrower);
        manager.draw(id, amount);
        calls["draw"]++;
    }

    function repay(uint256 seed, uint256 amount) external {
        (uint256 id, Line memory line) = _pick(seed, Status.Active, true);
        if (id == 0 || (line.status != Status.Active && line.status != Status.Breached)) return;
        uint256 debt = manager.debtOf(id);
        if (debt == 0 && line.status == Status.Active) return;
        amount = bound(amount, 0, debt + 1 ether);
        if (amount == 0 && debt > 0) return;
        vm.prank(actor);
        manager.repay(id, amount);
        calls["repay"]++;
        if (manager.lineOf(id).status != line.status) calls["cure"]++;
    }

    function warp(uint256 dt) external {
        time += bound(dt, 1, 3 days);
        vm.warp(time);
    }

    function breach(uint256 seed, uint8 termIndex) external {
        (uint256 id, Line memory line) = _pick(seed, Status.Active, false);
        if (id == 0 || line.status != Status.Active) return;
        Term[] memory terms = manager.termsOf(id);
        uint8 ti = uint8(termIndex % terms.length);
        if (terms[ti].retired) return;
        bytes memory txb = terms[ti].kind == CROSS_DEFAULT
            ? TxBuilder.encode(TxBuilder.liquidation(AAVE_MAINNET, line.linkedWallet, 1e6))
            : TxBuilder.encode(TxBuilder.transfer(USDC_MAINNET, line.linkedWallet, address(0xBEEF), 2e6));
        uint64 h = nextHeight++;
        INativeQueryVerifier.ContinuityProof memory c;
        vm.prank(actor);
        manager.reportBreach(id, ti, h, txb, _merkle(h), c, 0);
        calls["breach"]++;
    }

    function settle(uint256 seed) external {
        (uint256 id, Line memory line) = _pick(seed, Status.Breached, false);
        if (id == 0 || line.status != Status.Breached) return;
        if (manager.debtOf(id) == 0) return;
        if (time <= line.graceEnds) {
            time = line.graceEnds + 1;
            vm.warp(time);
        }
        vm.prank(actor);
        manager.settleDefault(id);
        calls["default"]++;
    }

    function close(uint256 seed) external {
        (uint256 id, Line memory line) = _pick(seed, Status.Active, false);
        if (id == 0 || line.status != Status.Active) return;
        uint256 debt = manager.debtOf(id);
        if (debt > 0) {
            vm.prank(actor);
            manager.repay(id, debt);
        }
        vm.prank(borrower);
        manager.closeLine(id);
        calls["close"]++;
    }
}

contract CovenantInvariantsTest is CovenantBase {
    CovenantHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new CovenantHandler(manager, pool, wctc);
        targetContract(address(handler));
    }

    function afterInvariant() external view {
        console.log("opens", handler.calls("open"), "draws", handler.calls("draw"));
        console.log("breaches", handler.calls("breach"), "cures", handler.calls("cure"));
        console.log("defaults", handler.calls("default"), "closes", handler.calls("close"));
    }

    /// @dev ERC-4626 accounting: totalAssets is exactly idle WCTC plus lent-out principal.
    function invariant_poolAssetsAreIdlePlusOutstanding() public view {
        assertEq(pool.totalAssets(), wctc.balanceOf(address(pool)) + pool.outstandingPrincipal());
    }

    /// @dev The manager holds bonds and nothing else.
    function invariant_bondsEqualManagerBalance() public view {
        uint256 sum;
        uint256 n = handler.lineCount();
        for (uint256 i; i < n; ++i) {
            sum += manager.lineOf(handler.lineIds(i)).bond;
        }
        assertEq(sum, wctc.balanceOf(address(manager)));
    }

    /// @dev Pool outstanding principal equals the principal of all open lines.
    function invariant_outstandingMatchesLines() public view {
        uint256 sum;
        uint256 n = handler.lineCount();
        for (uint256 i; i < n; ++i) {
            sum += manager.lineOf(handler.lineIds(i)).principal;
        }
        assertEq(sum, pool.outstandingPrincipal());
    }

    /// @dev No line's limit ever exceeds bond * maxLeverageBps.
    function invariant_limitWithinMaxLeverage() public view {
        uint256 n = handler.lineCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.lineIds(i);
            assertLe(manager.limitOf(id), manager.lineOf(id).bond * manager.maxLeverageBps() / 10_000);
            assertLe(manager.limitOf(id), manager.lineOf(id).bond * manager.MAX_LEVERAGE_BPS() / 10_000);
        }
    }
}
