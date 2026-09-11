// Cross-language fixtures: TypeScript computes Merkle leaves/proofs and sample indices; the
// Foundry test test/Fixtures.t.sol recomputes them in Solidity and asserts equality.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, keccak256, toHex } from "viem";
import { taskBytes, taskHash, type Task } from "../src/lib/bundle.js";
import { buildTaskTree, leafFor, proofForIndex, sampleIndicesFor } from "../src/lib/merkle.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../contracts/test/fixtures");
mkdirSync(out, { recursive: true });

const tasks: Task[] = Array.from({ length: 7 }, (_, i) => ({
  index: i,
  family: "arith",
  difficulty: 3,
  prompt: `Compute ${i} + ${i * 7}. Reply with only the integer.`,
  grader: { type: "numeric", value: String(i + i * 7), tolerance: 0 },
  reference: String(i + i * 7),
}));
const tree = buildTaskTree(tasks);
const merkle = {
  root: tree.root,
  tasks: tasks.map((t) => bytesToHex(taskBytes(t))),
  taskHashes: tasks.map(taskHash),
  leaves: tasks.map((t) => leafFor(t.index, taskHash(t))),
  proofs: tasks.map((t) => proofForIndex(tree, t.index)),
};
writeFileSync(resolve(out, "merkle-vectors.json"), JSON.stringify(merkle, null, 2));

const vectors = [
  { bh: keccak256(toHex("a")), id: 0n, n: 30, k: 4 },
  { bh: keccak256(toHex("b")), id: 7n, n: 8, k: 3 },
  { bh: keccak256(toHex("c")), id: 123456789n, n: 5, k: 5 },
  { bh: "0x" + "ff".repeat(32), id: 2n ** 200n, n: 1000, k: 16 },
  { bh: "0x" + "00".repeat(31) + "01", id: 1n, n: 2, k: 2 },
].map((v) => ({ bh: v.bh, id: v.id.toString(), n: v.n, k: v.k, expected: sampleIndicesFor(v.bh as `0x${string}`, v.id, v.n, v.k) }));
writeFileSync(resolve(out, "sample-vectors.json"), JSON.stringify({ vectors }, null, 2));
console.log("wrote fixtures:", merkle.root, vectors.map((v) => v.expected.join(",")).join(" | "));
