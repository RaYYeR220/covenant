// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICreditRecord} from "./interfaces/ICreditRecord.sol";

/// @title CreditRecord
/// @notice Append-only credit history keyed by the linked source-chain wallet. Only the
///         CovenantManager writes; any dApp can read `recordOf`.
contract CreditRecord is Ownable2Step, ICreditRecord {
    error NotManager();
    error ManagerAlreadySet();
    error ZeroAddress();

    /// @notice The only writer. Set once.
    address public manager;

    mapping(address wallet => Record) private _records;

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Wires the manager. Callable once.
    function setManager(address manager_) external onlyOwner {
        if (manager != address(0)) revert ManagerAlreadySet();
        if (manager_ == address(0)) revert ZeroAddress();
        manager = manager_;
        emit ManagerSet(manager_);
    }

    /// @inheritdoc ICreditRecord
    function recordKept(address wallet, uint256 provenRepays) external onlyManager {
        Record storage r = _records[wallet];
        r.kept += 1;
        r.provenRepays += SafeCast.toUint32(provenRepays);
        _touch(wallet, r, Action.Kept);
    }

    /// @inheritdoc ICreditRecord
    function recordBreach(address wallet) external onlyManager {
        Record storage r = _records[wallet];
        r.breaches += 1;
        _touch(wallet, r, Action.Breach);
    }

    /// @inheritdoc ICreditRecord
    function recordCure(address wallet) external onlyManager {
        Record storage r = _records[wallet];
        r.cures += 1;
        _touch(wallet, r, Action.Cure);
    }

    /// @inheritdoc ICreditRecord
    function recordDefault(address wallet) external onlyManager {
        Record storage r = _records[wallet];
        r.defaults += 1;
        _touch(wallet, r, Action.Default);
    }

    /// @inheritdoc ICreditRecord
    function recordOf(address wallet) external view returns (Record memory) {
        return _records[wallet];
    }

    function _touch(address wallet, Record storage r, Action action) private {
        r.lastUpdate = uint40(block.timestamp);
        emit RecordUpdated(wallet, action, r);
    }
}
