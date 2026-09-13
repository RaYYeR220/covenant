// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICovenantPool} from "./interfaces/ICovenantPool.sol";

/// @title CovenantPool
/// @notice ERC-4626 vault of WCTC that funds Covenant credit lines.
/// @dev `totalAssets = idle + outstandingPrincipal`. Only the manager can move funds out (lend) or
///      change the books (repay / write-off). The owner can only set the manager once and tune the
///      utilization cap inside fixed bounds; it has no path to pool funds.
contract CovenantPool is ERC4626, Ownable2Step, ReentrancyGuard, ICovenantPool {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_UTILIZATION_BPS = 1000;
    uint256 public constant MAX_UTILIZATION_BPS = 9500;

    error NotManager();
    error ManagerAlreadySet();
    error ZeroAddress();
    error ZeroAmount();
    error ParameterOutOfBounds();
    error UtilizationCapExceeded();
    error InsufficientIdle();
    error ExceedsOutstanding();

    /// @notice The CovenantManager allowed to lend and book repayments. Set once.
    address public manager;

    /// @inheritdoc ICovenantPool
    uint256 public outstandingPrincipal;

    /// @notice Max share of `totalAssets` that may be lent out, in bps.
    uint256 public maxUtilizationBps = 8000;

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    /// @param asset_ WCTC token.
    /// @param owner_ Initial owner (two-step transferable).
    constructor(IERC20 asset_, address owner_)
        ERC20("Covenant WCTC Pool", "cvWCTC")
        ERC4626(asset_)
        Ownable(owner_)
    {}

    // ------------------------------------------------------------------ owner

    /// @notice Wires the manager. Can only be called once so the owner can never redirect lending.
    function setManager(address manager_) external onlyOwner {
        if (manager != address(0)) revert ManagerAlreadySet();
        if (manager_ == address(0)) revert ZeroAddress();
        manager = manager_;
        emit ManagerSet(manager_);
    }

    /// @notice Sets the utilization cap, bounded to [10%, 95%].
    function setMaxUtilizationBps(uint256 bps) external onlyOwner {
        if (bps < MIN_UTILIZATION_BPS || bps > MAX_UTILIZATION_BPS) revert ParameterOutOfBounds();
        maxUtilizationBps = bps;
        emit MaxUtilizationUpdated(bps);
    }

    // ------------------------------------------------------------------ manager

    /// @inheritdoc ICovenantPool
    /// @dev Reverts if the loan would push outstanding principal above `maxUtilizationBps` of total assets.
    function lend(address to, uint256 amount) external onlyManager nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > idleAssets()) revert InsufficientIdle();
        uint256 newOutstanding = outstandingPrincipal + amount;
        // lending does not change totalAssets (idle -> outstanding), so compare against the current value
        if (newOutstanding * BPS > totalAssets() * maxUtilizationBps) revert UtilizationCapExceeded();

        outstandingPrincipal = newOutstanding;
        emit Lent(to, amount, newOutstanding);
        IERC20(asset()).safeTransfer(to, amount);
    }

    /// @inheritdoc ICovenantPool
    function onRepay(uint256 principal, uint256 interest) external onlyManager nonReentrant {
        if (principal > outstandingPrincipal) revert ExceedsOutstanding();
        outstandingPrincipal -= principal;
        emit RepaymentBooked(principal, interest, outstandingPrincipal);
    }

    /// @inheritdoc ICovenantPool
    function writeOff(uint256 principalLoss) external onlyManager nonReentrant {
        if (principalLoss > outstandingPrincipal) revert ExceedsOutstanding();
        outstandingPrincipal -= principalLoss;
        emit WrittenOff(principalLoss, outstandingPrincipal);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ICovenantPool
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Current utilization (outstanding / totalAssets) in bps.
    function utilizationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        return total == 0 ? 0 : Math.mulDiv(outstandingPrincipal, BPS, total);
    }

    /// @notice Idle WCTC plus principal currently lent out.
    function totalAssets() public view override returns (uint256) {
        return idleAssets() + outstandingPrincipal;
    }

    /// @notice Assets `owner_` can withdraw now: their position, capped by idle liquidity.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), idleAssets());
    }

    /// @notice Shares `owner_` can redeem now: their balance, capped by the shares idle liquidity covers.
    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(idleAssets(), Math.Rounding.Floor));
    }

    /// @dev Virtual shares/assets offset against first-depositor inflation attacks.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
