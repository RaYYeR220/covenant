// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title SourceRegistry
/// @notice Owner-controlled registry of the source-chain contracts Covenant trusts as log emitters.
/// @dev Lines snapshot the Aave pool for each of their chains at open, so registry edits only affect
///      lines opened afterwards. Pledge tokens are fixed in each term and only checked at open.
abstract contract SourceRegistry is Ownable2Step {
    /// @notice Aave V3 Pool per Attestcoin chain key.
    mapping(uint64 chainKey => address pool) public aavePool;

    /// @notice ERC-20 tokens a NEGATIVE_PLEDGE covenant may reference, per chain key.
    mapping(uint64 chainKey => mapping(address token => bool allowed)) public pledgeTokenAllowed;

    event AavePoolSet(uint64 indexed chainKey, address indexed pool);
    event PledgeTokenSet(uint64 indexed chainKey, address indexed token, bool allowed);

    /// @notice Registers (or clears, with address(0)) the Aave V3 Pool for `chainKey`.
    function setAavePool(uint64 chainKey, address pool) external onlyOwner {
        aavePool[chainKey] = pool;
        emit AavePoolSet(chainKey, pool);
    }

    /// @notice Allows or disallows `token` on `chainKey` for new NEGATIVE_PLEDGE covenants.
    function setPledgeToken(uint64 chainKey, address token, bool allowed) external onlyOwner {
        pledgeTokenAllowed[chainKey][token] = allowed;
        emit PledgeTokenSet(chainKey, token, allowed);
    }
}
