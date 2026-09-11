/**
 * Bundle format, graders and commitments.
 *
 * A bundle is a JSON document. Its on-chain commitment is keccak256 of its RFC 8785 (JSON
 * Canonicalization Scheme) bytes, and each task's Merkle leaf is built from keccak256 of the
 * task's own canonical bytes. Canonical JSON means the seller, buyer and arbiter all derive the
 * same bytes from the same value, so nobody has to ship "the exact bytes" around separately.
 */
import canonicalize from "canonicalize";
import { keccak256, type Hex } from "viem";
import { z } from "zod";

export type GraderType = "exact" | "numeric" | "regex" | "choice";

export const GraderSchema = z.object({
  type: z.enum(["exact", "numeric", "regex", "choice"]),
  value: z.string(),
  tolerance: z.number().nonnegative().optional(),
});
export type Grader = z.infer<typeof GraderSchema>;

export const TaskSchema = z.object({
  index: z.number().int().nonnegative(),
  family: z.string(),
  difficulty: z.number().int().min(1).max(5),
  prompt: z.string().min(1),
  grader: GraderSchema,
  reference: z.string(),
  /** Provenance for real benchmark items, e.g. "bbh/date_understanding/17" or "gsm8k/test/42". */
  sourceId: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Grading semantics version. Bump this whenever the MEANING of a score changes: the answer
 * normaliser, the number parser, the grader type set, or any grade() branch. The graders are a
 * consensus artifact — seller, buyer and arbiter each run them independently and money moves on
 * whether their numbers agree — so a silent change to grading is a silent change to who wins a
 * dispute. Pinning the version inside runParams makes a mismatch loud instead of invisible.
 */
export const GRADER_VERSION = "1";

/**
 * The pinned evaluation protocol: everything other than the tasks that must be identical across
 * the three parties for a score to be reproducible. The buyer commits keccak256 of this to the
 * chain as `spec.runParamsHash` at bounty creation, before it has seen anything.
 */
export const RunParamsSchema = z.object({
  temperature: z.number(),
  max_tokens: z.number().int().positive(),
  system: z.string(),
  /**
   * Optional only for backward compatibility with bundles committed before this field existed —
   * absent means "pre-versioning", and canonicalization omits the key so their hashes are
   * unchanged. It is still fully enforced for anything new: the buyer's on-chain runParamsHash
   * includes it, and buyer and arbiter both reject a bundle whose runParams do not hash to it.
   */
  graderVersion: z.string().optional(),
});
export type RunParams = z.infer<typeof RunParamsSchema>;

export const BundleSchema = z.object({
  version: z.literal(1),
  salt: z.string().regex(/^0x[0-9a-f]{64}$/),
  domainTag: z.string(),
  runParams: RunParamsSchema,
  tasks: z.array(TaskSchema),
  sellerMeasured: z.object({ weak: z.number(), strong: z.number(), null: z.number() }),
});
export type Bundle = z.infer<typeof BundleSchema>;

export const DEFAULT_RUN_PARAMS: RunParams = {
  temperature: 0,
  max_tokens: 64,
  system: "You are being evaluated. Reply with only the final answer and nothing else.",
  graderVersion: GRADER_VERSION,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** RFC 8785 canonical UTF-8 bytes of any JSON value. */
export function canonicalBytes(value: unknown): Uint8Array {
  const s = canonicalize(value);
  if (s === undefined) throw new Error("value is not canonicalizable JSON");
  return enc.encode(s);
}

export const taskBytes = (t: Task): Uint8Array => canonicalBytes(t);
export const taskHash = (t: Task): Hex => keccak256(taskBytes(t));
export const bundleBytes = (b: Bundle): Uint8Array => canonicalBytes(b);
export const bundleCommitment = (b: Bundle): Hex => keccak256(bundleBytes(b));
export const runParamsHash = (rp: RunParams): Hex => keccak256(canonicalBytes(rp));

/** Parse + validate bytes received from the chain. Never re-serialize: hash the input bytes. */
export function parseBundle(bytes: Uint8Array): Bundle {
  const parsed = JSON.parse(dec.decode(bytes));
  return BundleSchema.parse(parsed);
}

export function parseTask(bytes: Uint8Array): Task {
  return TaskSchema.parse(JSON.parse(dec.decode(bytes)));
}

// ------------------------------------------------------------------ grading

export function normalizeAnswer(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 2; i++) {
    t = t.replace(/[.。!]+$/, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  }
  return t.replace(/\s+/g, " ").toLowerCase();
}

/** Last number-like token in the answer ("The answer is 1,234.5" -> 1234.5). */
function parseNumber(s: string): number | null {
  const tokens = normalizeAnswer(s).match(/-?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?/g);
  if (!tokens || tokens.length === 0) return null;
  const n = Number(tokens[tokens.length - 1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Multiple-choice letter in a free-form answer: "(B)", "B", "B)", "b.", "The answer is (B)". */
export function parseChoice(answer: string): string | null {
  const paren = answer.match(/\(([A-Za-z])\)/);
  if (paren) return paren[1]!.toUpperCase();
  const lead = answer.trim().match(/^([A-Za-z])(?:[).:\s]|$)/);
  if (lead) return lead[1]!.toUpperCase();
  const tail = answer.trim().match(/\b([A-Za-z])[).]?\s*$/);
  if (tail) return tail[1]!.toUpperCase();
  return null;
}

/** 1 if the answer passes the task's grader, 0 otherwise. */
export function grade(task: Task, answer: string): 0 | 1 {
  const g = task.grader;
  if (answer.trim() === "") return 0;
  switch (g.type) {
    case "choice":
      return parseChoice(answer) === g.value.toUpperCase() ? 1 : 0;
    case "exact":
      return normalizeAnswer(answer) === normalizeAnswer(g.value) ? 1 : 0;
    case "numeric": {
      const a = parseNumber(answer);
      const b = parseNumber(g.value);
      if (a === null || b === null) return 0;
      const tol = g.tolerance ?? 0;
      return Math.abs(a - b) <= tol + 1e-9 ? 1 : 0;
    }
    case "regex": {
      try {
        return new RegExp(g.value, "i").test(answer.trim()) ? 1 : 0;
      } catch {
        return 0;
      }
    }
  }
}

/** Objective sanity checks a buyer runs on a revealed task before spending any model calls. */
export function objectiveTaskChecks(task: Task, expectedIndex: number, domainTag: string): string[] {
  const problems: string[] = [];
  if (task.index !== expectedIndex) problems.push(`index ${task.index} != sampled ${expectedIndex}`);
  if (task.prompt.trim().length < 12) problems.push("prompt is too short to be a real task");
  if (task.reference.trim() === "") problems.push("empty reference answer");
  if (grade(task, task.reference) !== 1) problems.push("reference answer fails its own grader");
  if (task.grader.type === "regex") {
    try {
      new RegExp(task.grader.value);
    } catch {
      problems.push("grader regex does not compile");
    }
    if (/^\.\*$|^\^?\.\*\$?$|^\(\?:\)$/.test(task.grader.value)) problems.push("grader regex accepts anything");
  }
  if (task.grader.type === "numeric" && (task.grader.tolerance ?? 0) > Math.max(1, Math.abs(Number(task.grader.value)) * 0.5)) {
    problems.push("numeric tolerance is so wide the grader is meaningless");
  }
  if (/what (integer|number) am i thinking of|guess/i.test(task.prompt)) problems.push("prompt is not answerable from its own text");
  if (domainTag && !task.family) problems.push("task has no family tag");
  return problems;
}
