/**
 * Merkle commitments over tasks and the sample-selection rule.
 *
 * Tree: OpenZeppelin StandardMerkleTree with leaf types (uint256 index, bytes32 taskHash).
 * Leaf = keccak256(bytes.concat(keccak256(abi.encode(index, keccak256(taskBytes))))) — the same
 * double-hash the contract recomputes in revealSample, verified with OZ MerkleProof.verify.
 *
 * Sample rule (must match EvalBounty.sampleIndicesFor byte-for-byte):
 *   idx = uint256(keccak256(abi.encode(blockhash, bountyId, nonce))) % N, nonce++ until k distinct.
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { taskHash, type Task } from "./bundle.js";

export type TaskTree = StandardMerkleTree<[string, Hex]>;

export function buildTaskTree(tasks: Task[]): TaskTree {
  const values: [string, Hex][] = tasks.map((t) => [t.index.toString(), taskHash(t)]);
  return StandardMerkleTree.of(values, ["uint256", "bytes32"]);
}

export function proofForIndex(tree: TaskTree, index: number): Hex[] {
  for (const [i, v] of tree.entries()) {
    if (v[0] === index.toString()) return tree.getProof(i) as Hex[];
  }
  throw new Error(`index ${index} not in tree`);
}

/** Recompute a leaf exactly as the contract does; useful in tests and buyer-side checks. */
export function leafFor(index: number, taskBytesHash: Hex): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(index), taskBytesHash]));
  return keccak256(inner);
}

export function sampleIndicesFor(blockhash: Hex, bountyId: bigint, n: number, k: number): number[] {
  if (k < 1 || k > n) throw new Error("k must be in 1..n");
  const chosen: number[] = [];
  let nonce = 0n;
  while (chosen.length < k) {
    const h = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [blockhash, bountyId, nonce]),
    );
    const idx = Number(BigInt(h) % BigInt(n));
    if (!chosen.includes(idx)) chosen.push(idx);
    nonce++;
  }
  return chosen;
}

/** Probability a bundle with junk fraction f passes a k-sample check. Used in logs and the README. */
export function junkPassProbability(junkFraction: number, k: number): number {
  return Math.pow(1 - junkFraction, k);
}
