// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IChainInfo} from "../../src/interfaces/IChainInfo.sol";

/// @dev Stand-in for the ChainInfo precompile. Etched at 0x0FD3 in tests.
contract MockChainInfo {
    mapping(uint64 => IChainInfo.HeightHashResult) internal _latest;

    function setLatest(uint64 chainKey, uint64 height) external {
        _latest[chainKey] = IChainInfo.HeightHashResult({
            height: height, hash: keccak256(abi.encode(chainKey, height)), isAttestation: true, exists: true
        });
    }

    function clear(uint64 chainKey) external {
        delete _latest[chainKey];
    }

    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (IChainInfo.HeightHashResult memory)
    {
        return _latest[chainKey];
    }
}
