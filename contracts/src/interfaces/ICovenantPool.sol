// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICovenantPool
/// @notice Manager-facing surface of the Covenant ERC-4626 lending pool.
interface ICovenantPool {
    event ManagerSet(address indexed manager);
    event MaxUtilizationUpdated(uint256 maxUtilizationBps);
    event Lent(address indexed to, uint256 amount, uint256 outstandingPrincipal);
    event RepaymentBooked(uint256 principal, uint256 interest, uint256 outstandingPrincipal);
    event WrittenOff(uint256 principalLoss, uint256 outstandingPrincipal);

    /// @notice Sends `amount` of idle asset to `to` and books it as outstanding principal.
    function lend(address to, uint256 amount) external;

    /// @notice Books a repayment whose asset the manager has already transferred in.
    function onRepay(uint256 principal, uint256 interest) external;

    /// @notice Removes unrecoverable principal from the books, lowering the share price.
    function writeOff(uint256 principalLoss) external;

    function outstandingPrincipal() external view returns (uint256);

    function idleAssets() external view returns (uint256);
}
