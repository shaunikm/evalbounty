import { describe, expect, it } from "vitest";
import { grade, objectiveTaskChecks } from "../src/lib/bundle.js";
import { FAMILIES, generateJunkTasks, generateTasks } from "../src/lib/generators.js";

describe("task generators", () => {
  it("every family's reference passes its own grader, for every difficulty", () => {
    for (const difficulty of [1, 2, 3, 4, 5]) {
      const tasks = generateTasks({ seed: `s-${difficulty}`, count: 36, difficulty });
      expect(tasks).toHaveLength(36);
      for (const t of tasks) {
        expect(grade(t, t.reference), `${t.family}: ${t.prompt} -> ${t.reference}`).toBe(1);
        expect(objectiveTaskChecks(t, t.index, "exact-answer-reasoning")).toEqual([]);
      }
      expect(new Set(tasks.map((t) => t.family))).toEqual(new Set(FAMILIES));
    }
  });
  it("is deterministic for a seed and differs across seeds", () => {
    const a = generateTasks({ seed: "x", count: 6, difficulty: 3 });
    const b = generateTasks({ seed: "x", count: 6, difficulty: 3 });
    const c = generateTasks({ seed: "y", count: 6, difficulty: 3 });
    expect(a).toEqual(b);
    expect(a.map((t) => t.prompt)).not.toEqual(c.map((t) => t.prompt));
  });
  it("junk tasks are flagged by the objective checks", () => {
    const junk = generateJunkTasks({ seed: "j", count: 3, difficulty: 3 });
    for (const t of junk) expect(objectiveTaskChecks(t, t.index, "x").length).toBeGreaterThan(0);
  });
});
