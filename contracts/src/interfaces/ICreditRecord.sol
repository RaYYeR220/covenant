// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICreditRecord
/// @notice Append-only, public credit history per linked source-chain wallet.
interface ICreditRecord {
    enum Action {
        Kept,
        Breach,
        Cure,
        Default
    }

    struct Record {
        uint32 kept;
        uint32 breaches;
        uint32 cures;
        uint32 defaults;
        uint32 provenRepays;
        uint40 lastUpdate;
    }

    event ManagerSet(address indexed manager);
    event RecordUpdated(address indexed wallet, Action indexed action, Record record);

    /// @notice A line was closed with all obligations met; adds the line's proven repays.
    function recordKept(address wallet, uint256 provenRepays) external;

    function recordBreach(address wallet) external;

    function recordCure(address wallet) external;

    function recordDefault(address wallet) external;

    /// @notice Full record of `wallet`.
    function recordOf(address wallet) external view returns (Record memory);
}
