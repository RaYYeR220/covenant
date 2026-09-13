// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev Loads real Attestcoin proof JSON (as returned by the proof-builder API) from test/fixtures.
library Fixtures {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Proof {
        uint64 chainKey;
        uint64 height;
        uint64 txIndex;
        bytes32 txHash;
        bytes txBytes;
        INativeQueryVerifier.MerkleProof merkle;
        INativeQueryVerifier.ContinuityProof continuity;
    }

    struct Batch {
        uint64 chainKey;
        uint64[] heights;
        uint64[] txIndexes;
        bytes[] txBytes;
        INativeQueryVerifier.MerkleProof[] merkles;
        INativeQueryVerifier.ContinuityProof continuity;
    }

    function read(string memory file) internal view returns (string memory) {
        return vm.readFile(string.concat("test/fixtures/", file));
    }

    function proof(string memory file) internal view returns (Proof memory p) {
        string memory json = read(file);
        p.chainKey = uint64(vm.parseJsonUint(json, ".chainKey"));
        p.height = uint64(vm.parseJsonUint(json, ".headerNumber"));
        p.txIndex = uint64(vm.parseJsonUint(json, ".txIndex"));
        p.txHash = vm.parseJsonBytes32(json, ".txHash");
        p.txBytes = vm.parseJsonBytes(json, ".txBytes");
        p.merkle = merkle(json, ".merkleProof");
        p.continuity = continuity(json, ".continuityProof");
    }

    /// @dev Batch shape: {chainKey, continuityProof, merkleProofs: {"<height>": {"<txIndex>": {txBytes, merkleProof}}}}.
    function batch(string memory file) internal view returns (Batch memory b) {
        string memory json = read(file);
        b.chainKey = uint64(vm.parseJsonUint(json, ".chainKey"));
        b.continuity = continuity(json, ".continuityProof");

        string[] memory heightKeys = vm.parseJsonKeys(json, ".merkleProofs");
        uint256 n;
        for (uint256 i; i < heightKeys.length; ++i) {
            n += vm.parseJsonKeys(json, string.concat(".merkleProofs.", heightKeys[i])).length;
        }
        b.heights = new uint64[](n);
        b.txIndexes = new uint64[](n);
        b.txBytes = new bytes[](n);
        b.merkles = new INativeQueryVerifier.MerkleProof[](n);

        uint256 k;
        for (uint256 i; i < heightKeys.length; ++i) {
            string memory hPath = string.concat(".merkleProofs.", heightKeys[i]);
            string[] memory idxKeys = vm.parseJsonKeys(json, hPath);
            for (uint256 j; j < idxKeys.length; ++j) {
                string memory entry = string.concat(hPath, ".", idxKeys[j]);
                b.heights[k] = uint64(vm.parseUint(heightKeys[i]));
                b.txIndexes[k] = uint64(vm.parseUint(idxKeys[j]));
                b.txBytes[k] = vm.parseJsonBytes(json, string.concat(entry, ".txBytes"));
                b.merkles[k] = merkle(json, string.concat(entry, ".merkleProof"));
                k++;
            }
        }
        _sortByHeight(b);
    }

    function merkle(string memory json, string memory path) internal view returns (INativeQueryVerifier.MerkleProof memory m) {
        m.root = vm.parseJsonBytes32(json, string.concat(path, ".root"));
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(path, ".siblings[", vm.toString(n), "]"))) n++;
        m.siblings = new INativeQueryVerifier.MerkleProofEntry[](n);
        for (uint256 i; i < n; ++i) {
            string memory s = string.concat(path, ".siblings[", vm.toString(i), "]");
            m.siblings[i] = INativeQueryVerifier.MerkleProofEntry({
                hash: vm.parseJsonBytes32(json, string.concat(s, ".hash")),
                isLeft: vm.parseJsonBool(json, string.concat(s, ".isLeft"))
            });
        }
    }

    function continuity(string memory json, string memory path)
        internal
        pure
        returns (INativeQueryVerifier.ContinuityProof memory c)
    {
        c.lowerEndpointDigest = vm.parseJsonBytes32(json, string.concat(path, ".lowerEndpointDigest"));
        c.roots = vm.parseJsonBytes32Array(json, string.concat(path, ".roots"));
    }

    function _sortByHeight(Batch memory b) private pure {
        uint256 n = b.heights.length;
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && b.heights[j - 1] > b.heights[j]; --j) {
                (b.heights[j - 1], b.heights[j]) = (b.heights[j], b.heights[j - 1]);
                (b.txIndexes[j - 1], b.txIndexes[j]) = (b.txIndexes[j], b.txIndexes[j - 1]);
                (b.txBytes[j - 1], b.txBytes[j]) = (b.txBytes[j], b.txBytes[j - 1]);
                (b.merkles[j - 1], b.merkles[j]) = (b.merkles[j], b.merkles[j - 1]);
            }
        }
    }
}
