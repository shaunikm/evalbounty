import { describe, expect, it } from "vitest";
import { bundleCommitment, DEFAULT_RUN_PARAMS, type Bundle } from "../src/lib/bundle.js";
import { generateJunkTasks, generateTasks } from "../src/lib/generators.js";
import { mockProvider, mockWrongProbability, NULL_MODEL } from "../src/lib/models.js";
import { claimsHold, insideBand, measureBundle, resamplingStandardError, transcriptHash, type ClaimSpec } from "../src/lib/verify.js";

const spec: ClaimSpec = { weakModel: "mock-weak", strongModel: "mock-strong", weakMaxBps: 3500, strongMinBps: 6500, nullMaxBps: 500, runs: 2, toleranceBps: 1000 };

function bundleAt(difficulty: number, junk = false): Bundle {
  const tasks = junk ? generateJunkTasks({ seed: "junk", count: 30, difficulty }) : generateTasks({ seed: `d${difficulty}`, count: 30, difficulty });
  return { version: 1, salt: "0x" + "11".repeat(32), domainTag: "exact-answer-reasoning", runParams: DEFAULT_RUN_PARAMS, tasks, sellerMeasured: { weak: 0, strong: 0, null: 0 } };
}

describe("mock provider", () => {
  it("is deterministic and monotone in difficulty", async () => {
    const b = bundleAt(3);
    const t = b.tasks[0]!;
    const a1 = await mockProvider.complete("mock-weak", t.prompt, b.runParams, { task: t, run: 0 });
    const a2 = await mockProvider.complete("mock-weak", t.prompt, b.runParams, { task: t, run: 0 });
    expect(a1).toBe(a2);
    expect(mockWrongProbability("mock-weak", 1)).toBeLessThan(mockWrongProbability("mock-weak", 5));
    expect(mockWrongProbability("mock-strong", 3)).toBeLessThan(mockWrongProbability("mock-weak", 3));
    expect(await mockProvider.complete(NULL_MODEL, t.prompt, b.runParams, { task: t, run: 0 })).toBe("0");
  });
});

describe("claim verification", () => {
  it("a difficulty-3 bundle lands inside the demo band; difficulty 1 fails the weak ceiling", async () => {
    // an honest seller tunes difficulty; at least one of the middle settings must sit inside the band
    const inBand: number[] = [];
    for (const d of [3, 4]) {
      const b = bundleAt(d);
      const t = await measureBundle(b, spec, mockProvider, bundleCommitment(b));
      expect(t.scores.null).toBeLessThanOrEqual(500);
      if (insideBand(t.scores, spec)) {
        inBand.push(d);
        expect(claimsHold(t.scores, spec).ok).toBe(true);
      }
    }
    expect(inBand.length, "no difficulty inside band").toBeGreaterThan(0);

    const b1 = bundleAt(1);
    const t1 = await measureBundle(b1, spec, mockProvider, bundleCommitment(b1));
    const v = claimsHold(t1.scores, spec);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/weak model scored/);
  });
  it("junk bundles fail the strong-model floor (nobody can answer them)", async () => {
    const j = bundleAt(3, true);
    const t = await measureBundle(j, spec, mockProvider, bundleCommitment(j));
    expect(t.scores.strong).toBe(0);
    expect(claimsHold(t.scores, spec).reasons.join(" ")).toMatch(/strong model scored/);
  });
  it("reruns reproduce the transcript hash exactly on the mock", async () => {
    const b = bundleAt(3);
    const a = await measureBundle(b, spec, mockProvider, bundleCommitment(b));
    const c = await measureBundle(b, spec, mockProvider, bundleCommitment(b), { concurrency: 3 });
    expect(transcriptHash(a)).toBe(transcriptHash(c));
  });
  it("standard error formula", () => {
    expect(resamplingStandardError([0.5, 0.5, 0.5, 0.5], 1)).toBeCloseTo(0.25, 6);
    expect(resamplingStandardError([1, 1, 0, 0], 3)).toBe(0);
    expect(resamplingStandardError([], 3)).toBe(0);
  });
});
