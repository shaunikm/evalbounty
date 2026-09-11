import { describe, expect, it } from "vitest";
import { grade, objectiveTaskChecks, parseChoice, type Task } from "../src/lib/bundle.js";
import { MIXES, allItems, families, sampleTasks } from "../src/lib/datasets.js";

describe("real benchmark snapshots", () => {
  it("loads BBH and GSM8K items with stable provenance ids", () => {
    const items = allItems();
    expect(items.length).toBeGreaterThan(4000);
    expect(families()).toContain("gsm8k");
    expect(families()).toContain("date_understanding");
    expect(items.every((i) => /^(bbh\/[a-z_]+\/\d+|gsm8k\/test\/\d+)$/.test(i.id))).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
  it("every reference answer passes its own grader, for a sample of every family", () => {
    for (const f of families()) {
      const tasks = sampleTasks({ seed: `t-${f}`, count: 20, difficulty: 3, families: [f] });
      for (const t of tasks) {
        expect(grade(t, t.reference), `${t.sourceId}: ${t.reference}`).toBe(1);
        expect(objectiveTaskChecks(t, t.index, "benchmark-reasoning")).toEqual([]);
      }
    }
  });
  it("sampling is deterministic, duplicate-free and follows the mix", () => {
    const a = sampleTasks({ seed: "x", count: 30, difficulty: 3 });
    const b = sampleTasks({ seed: "x", count: 30, difficulty: 3 });
    const c = sampleTasks({ seed: "y", count: 30, difficulty: 3 });
    expect(a).toEqual(b);
    expect(a.map((t) => t.sourceId)).not.toEqual(c.map((t) => t.sourceId));
    expect(new Set(a.map((t) => t.sourceId)).size).toBe(30);
    for (const t of a) expect(MIXES[3]).toContain(t.family);
    expect(a.map((t) => t.index)).toEqual([...Array(30).keys()]);
  });
  it("every mix level is populated with known families", () => {
    const known = new Set(families());
    for (const [lvl, fams] of Object.entries(MIXES)) {
      expect(fams.length, `level ${lvl}`).toBeGreaterThan(0);
      for (const f of fams) expect(known.has(f), `${f} in level ${lvl}`).toBe(true);
    }
  });
});

describe("choice grader", () => {
  const t: Task = { index: 0, family: "date_understanding", difficulty: 3, prompt: "Which? Options: (A) x (B) y", grader: { type: "choice", value: "B" }, reference: "B" };
  it("accepts the letter in any common form", () => {
    for (const a of ["(B)", "B", "b", "B)", "B.", "The answer is (B).", "Answer: B"]) expect(grade(t, a), a).toBe(1);
    for (const a of ["(A)", "A", "C) because", ""]) expect(grade(t, a), a).toBe(0);
    expect(parseChoice("no letters here 42")).toBeNull();
  });
});
