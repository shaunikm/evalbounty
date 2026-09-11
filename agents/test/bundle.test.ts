import { describe, expect, it } from "vitest";
import { bundleBytes, bundleCommitment, canonicalBytes, grade, objectiveTaskChecks, parseBundle, type Bundle, type RunParams, type Task, DEFAULT_RUN_PARAMS, GRADER_VERSION, runParamsHash } from "../src/lib/bundle.js";

const task = (over: Partial<Task> = {}): Task => ({
  index: 0,
  family: "arith",
  difficulty: 3,
  prompt: "Compute 2 + 2. Reply with only the integer.",
  grader: { type: "numeric", value: "4", tolerance: 0 },
  reference: "4",
  ...over,
});

describe("canonical bytes", () => {
  it("is independent of key order and whitespace", () => {
    const a = canonicalBytes({ b: 1, a: [1, 2, { z: "x", y: null }] });
    const b = canonicalBytes({ a: [1, 2, { y: null, z: "x" }], b: 1 });
    expect(Buffer.from(a).toString()).toBe(Buffer.from(b).toString());
    expect(Buffer.from(a).toString()).toBe('{"a":[1,2,{"y":null,"z":"x"}],"b":1}');
  });
  it("bundle round-trips: parse(bytes) re-canonicalizes to the same bytes and commitment", () => {
    const bundle: Bundle = {
      version: 1,
      salt: "0x" + "ab".repeat(32),
      domainTag: "exact-answer-reasoning",
      runParams: DEFAULT_RUN_PARAMS,
      tasks: [task(), task({ index: 1, prompt: "Compute 3 + 3. Reply with only the integer.", reference: "6", grader: { type: "numeric", value: "6", tolerance: 0 } })],
      sellerMeasured: { weak: 3000, strong: 7000, null: 0 },
    };
    const bytes = bundleBytes(bundle);
    const parsed = parseBundle(bytes);
    expect(Buffer.from(bundleBytes(parsed))).toEqual(Buffer.from(bytes));
    expect(bundleCommitment(parsed)).toBe(bundleCommitment(bundle));
    expect(runParamsHash(parsed.runParams)).toBe(runParamsHash(DEFAULT_RUN_PARAMS));
  });
  it("rejects malformed bundles", () => {
    expect(() => parseBundle(new TextEncoder().encode('{"version":2}'))).toThrow();
  });
});

describe("graders", () => {
  it("numeric tolerates formatting", () => {
    expect(grade(task(), "4")).toBe(1);
    expect(grade(task(), " 4. ")).toBe(1);
    expect(grade(task(), "The answer is 4")).toBe(1);
    expect(grade(task(), "5")).toBe(0);
    expect(grade(task(), "")).toBe(0);
    expect(grade(task({ grader: { type: "numeric", value: "1234567", tolerance: 0 } }), "1,234,567")).toBe(1);
    expect(grade(task({ grader: { type: "numeric", value: "12.34", tolerance: 0.02 } }), "12.35")).toBe(1);
    expect(grade(task({ grader: { type: "numeric", value: "12.34", tolerance: 0.02 } }), "12.40")).toBe(0);
  });
  it("exact normalizes case, quotes and trailing period", () => {
    const t = task({ grader: { type: "exact", value: "Tuesday" }, reference: "Tuesday" });
    expect(grade(t, "tuesday")).toBe(1);
    expect(grade(t, '"Tuesday".')).toBe(1);
    expect(grade(t, "Wednesday")).toBe(0);
  });
  it("regex", () => {
    const t = task({ grader: { type: "regex", value: "^(4|four)$" }, reference: "4" });
    expect(grade(t, "four")).toBe(1);
    expect(grade(t, "44")).toBe(0);
  });
});

describe("objective task checks", () => {
  it("passes a well-formed task", () => {
    expect(objectiveTaskChecks(task(), 0, "exact-answer-reasoning")).toEqual([]);
  });
  it("flags index mismatch, self-failing reference and unanswerable prompts", () => {
    expect(objectiveTaskChecks(task(), 3, "x")).toContain("index 0 != sampled 3");
    expect(objectiveTaskChecks(task({ reference: "5" }), 0, "x")).toContain("reference answer fails its own grader");
    expect(objectiveTaskChecks(task({ prompt: "I am thinking of an integer between 1 and 100. What integer am I thinking of?" }), 0, "x").some((p) => /not answerable/.test(p))).toBe(true);
    expect(objectiveTaskChecks(task({ grader: { type: "regex", value: ".*" }, reference: "x" }), 0, "x").some((p) => /accepts anything/.test(p))).toBe(true);
  });
});

describe("grader version pinning", () => {
  it("is part of the pinned run params the buyer commits on-chain", () => {
    expect(DEFAULT_RUN_PARAMS.graderVersion).toBe(GRADER_VERSION);
    expect(Buffer.from(canonicalBytes(DEFAULT_RUN_PARAMS)).toString()).toContain('"graderVersion"');
  });

  it("changing grading semantics changes the hash, so buyer and arbiter cannot silently diverge", () => {
    const bumped: RunParams = { ...DEFAULT_RUN_PARAMS, graderVersion: "2" };
    expect(runParamsHash(bumped)).not.toBe(runParamsHash(DEFAULT_RUN_PARAMS));
  });

  it("bundles committed before the field existed still parse and keep their original hash", () => {
    // Back-compat: an in-flight bounty delivered under the old format must still resolve, so the
    // field is optional and canonicalization omits it rather than defaulting it in.
    const { graderVersion: _omit, ...legacy } = DEFAULT_RUN_PARAMS;
    const bundle = {
      version: 1 as const,
      salt: "0x" + "cd".repeat(32),
      domainTag: "exact-answer-reasoning",
      runParams: legacy,
      tasks: [task()],
      sellerMeasured: { weak: 3000, strong: 7000, null: 0 },
    };
    const bytes = bundleBytes(bundle as Bundle);
    const parsed = parseBundle(bytes);
    expect(parsed.runParams.graderVersion).toBeUndefined();
    expect(runParamsHash(parsed.runParams)).toBe(runParamsHash(legacy));
    expect(runParamsHash(parsed.runParams)).not.toBe(runParamsHash(DEFAULT_RUN_PARAMS));
  });
});
