// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IChainInfo
/// @notice Subset of the Creditcoin ChainInfo precompile at `0x0FD3` used by Covenant.
/// @dev Mirrors the ABI shipped with `@gluwa/usc-sdk` (`chain_info.json`). Native precompiles have no
///      bytecode, which is fine here: calls to functions with return values skip the extcodesize check.
interface IChainInfo {
    struct HeightHashResult {
        uint64 height;
        bytes32 hash;
        bool isAttestation;
        bool exists;
    }

    /// @notice Latest attested height and digest for `chainKey`. `exists` is false if nothing is attested.
    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result);
}

library ChainInfoLib {
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000fD3;
}
