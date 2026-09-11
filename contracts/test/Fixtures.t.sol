// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EvalBounty} from "../src/EvalBounty.sol";
import {CentralizedArbitrator} from "../src/CentralizedArbitrator.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";

// Cross-language tests: fixtures are produced by agents/scripts/gen-fixtures.ts (TypeScript,
// @openzeppelin/merkle-tree + viem) and re-derived here in Solidity.
contract FixturesTest is Test {
    EvalBounty m;

    function setUp() public {
        CentralizedArbitrator arb = new CentralizedArbitrator(address(this), 0, bytes32(0));
        m = new EvalBounty(IArbitrator(address(arb)), address(this), EvalBounty.Windows(1, 1, 1, 1), "");
    }

    function test_MerkleLeavesAndProofsMatchTypeScript() public view {
        string memory json = vm.readFile("test/fixtures/merkle-vectors.json");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        bytes[] memory tasks = vm.parseJsonBytesArray(json, ".tasks");
        bytes32[] memory taskHashes = vm.parseJsonBytes32Array(json, ".taskHashes");
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, ".leaves");
        assertEq(tasks.length, 7);
        for (uint256 i; i < tasks.length; ++i) {
            assertEq(keccak256(tasks[i]), taskHashes[i], "task hash");
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(i, keccak256(tasks[i])))));
            assertEq(leaf, leaves[i], "leaf format");
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(".proofs[", vm.toString(i), "]"));
            assertTrue(MerkleProof.verify(proof, root, leaf), "proof verifies");
            // a proof for the wrong index must not verify
            bytes32 wrongLeaf = keccak256(bytes.concat(keccak256(abi.encode(i + 1, keccak256(tasks[i])))));
            assertFalse(MerkleProof.verify(proof, root, wrongLeaf), "wrong index rejected");
        }
    }

    function test_SampleIndicesMatchTypeScript() public view {
        string memory json = vm.readFile("test/fixtures/sample-vectors.json");
        for (uint256 v; v < 5; ++v) {
            string memory p = string.concat(".vectors[", vm.toString(v), "]");
            bytes32 bh = vm.parseJsonBytes32(json, string.concat(p, ".bh"));
            uint256 id = vm.parseJsonUint(json, string.concat(p, ".id"));
            uint256 n = vm.parseJsonUint(json, string.concat(p, ".n"));
            uint256 k = vm.parseJsonUint(json, string.concat(p, ".k"));
            uint256[] memory expected = vm.parseJsonUintArray(json, string.concat(p, ".expected"));
            uint256[] memory got = m.sampleIndicesFor(bh, id, uint32(n), uint8(k));
            assertEq(got.length, expected.length, "length");
            for (uint256 i; i < got.length; ++i) assertEq(got[i], expected[i], "index");
        }
    }
}
