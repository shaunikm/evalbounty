import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { taskHash, type Task } from "../src/lib/bundle.js";
import { buildTaskTree, junkPassProbability, leafFor, proofForIndex, sampleIndicesFor } from "../src/lib/merkle.js";

const tasks: Task[] = Array.from({ length: 30 }, (_, i) => ({
  index: i,
  family: "arith",
  difficulty: 2,
  prompt: `Compute ${i} * 3. Reply with only the integer.`,
  grader: { type: "numeric", value: String(i * 3), tolerance: 0 },
  reference: String(i * 3),
}));

describe("task merkle tree", () => {
  it("proofs verify and leaf format matches OZ StandardMerkleTree", () => {
    const tree = buildTaskTree(tasks);
    for (const t of [tasks[0]!, tasks[13]!, tasks[29]!]) {
      const proof = proofForIndex(tree, t.index);
      expect(StandardMerkleTree.verify(tree.root, ["uint256", "bytes32"], [t.index.toString(), taskHash(t)], proof)).toBe(true);
      expect(leafFor(t.index, taskHash(t))).toBe(tree.leafHash([t.index.toString(), taskHash(t)]));
      // wrong index with the same task bytes must fail
      expect(StandardMerkleTree.verify(tree.root, ["uint256", "bytes32"], [(t.index + 1).toString(), taskHash(t)], proof)).toBe(false);
    }
  });
  it("root changes when any task changes", () => {
    const a = buildTaskTree(tasks).root;
    const mutated = tasks.map((t) => (t.index === 17 ? { ...t, reference: "999" } : t));
    expect(buildTaskTree(mutated).root).not.toBe(a);
  });
});

describe("sample indices", () => {
  it("are distinct, in range, deterministic", () => {
    for (let trial = 0; trial < 50; trial++) {
      const bh = keccak256(toHex(`trial-${trial}`));
      const idx = sampleIndicesFor(bh, BigInt(trial), 30, 4);
      expect(idx).toHaveLength(4);
      expect(new Set(idx).size).toBe(4);
      for (const i of idx) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(30);
      }
      expect(sampleIndicesFor(bh, BigInt(trial), 30, 4)).toEqual(idx);
    }
    expect(sampleIndicesFor(keccak256(toHex("x")), 1n, 5, 5).sort()).toEqual([0, 1, 2, 3, 4]);
  });
  it("matches the Solidity fixture vectors", () => {
    const fx = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/sample-vectors.json", import.meta.url), "utf8"));
    for (const v of fx.vectors) expect(sampleIndicesFor(v.bh, BigInt(v.id), v.n, v.k)).toEqual(v.expected);
  });
  it("junk pass probability", () => {
    expect(junkPassProbability(0.3, 4)).toBeCloseTo(0.2401, 4);
    expect(junkPassProbability(1, 1)).toBe(0);
  });
});
