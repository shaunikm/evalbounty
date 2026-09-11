// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal Merkle builder for tests. Uses OpenZeppelin's commutative (sorted-pair) hashing so
// the proofs verify with MerkleProof.verify, and the same double-hashed leaf format as
// @openzeppelin/merkle-tree's StandardMerkleTree with types (uint256, bytes32).
library TestMerkle {
    function leaf(uint256 index, bytes memory task) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, keccak256(task)))));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) level = _next(level);
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        bytes32[] memory buf = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) buf[n++] = level[sib];
            level = _next(level);
            idx /= 2;
        }
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) out[i] = buf[i];
    }

    function _next(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 p; p < level.length; p += 2) {
            next[p / 2] = p + 1 < level.length ? hashPair(level[p], level[p + 1]) : level[p];
        }
    }
}
