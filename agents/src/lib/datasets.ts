/**
 * Real evaluation items. Bundles are sampled from committed snapshots of public benchmark suites
 * (agents/data/*.json, produced by scripts/fetch-datasets.ts):
 *
 *   - BIG-Bench Hard (Suzgun et al., 2022) — 13 exact-answer reasoning subtasks, MIT
 *   - GSM8K test split (Cobbe et al., 2021) — grade-school math word problems, MIT
 *
 * "Difficulty" is a mix level 1..5 over subtasks, ordered by measured scores of the pinned
 * weak/strong models (scripts/calibrate-families.ts). Level 1 is what a dishonest seller ships
 * while claiming the band; level 3 is where an honest seller lands for the default band.
 *
 * Note for the README: public benchmark items are, by definition, the contaminated case. The demo
 * uses them because they have unambiguous graders and known difficulty; a real seller's value is
 * precisely that its items are NOT public, which is what the buyer cannot check before paying and
 * what the random sample is for.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Grader, Task } from "./bundle.js";
import { Rng } from "./generators.js";

export type Kind = "choice" | "numeric" | "exact";
export interface Item {
  id: string;
  family: string;
  kind: Kind;
  prompt: string;
  answer: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, "../../data");

let cache: Item[] | undefined;
/** All snapshot items (BBH + GSM8K), loaded once. */
export function allItems(): Item[] {
  if (!cache) {
    const bbh = JSON.parse(readFileSync(resolve(DATA_DIR, "bbh.json"), "utf8")) as { items: Item[] };
    const gsm = JSON.parse(readFileSync(resolve(DATA_DIR, "gsm8k.json"), "utf8")) as { items: Item[] };
    cache = [...bbh.items, ...gsm.items];
  }
  return cache;
}

export function families(): string[] {
  return [...new Set(allItems().map((i) => i.family))];
}

/**
 * Difficulty mixes, from measured accuracy of gpt-4.1-nano (no reasoning) vs gpt-5-nano (low
 * reasoning) per family (scripts/calibrate-families.ts, 2026-09-11). Level 1 = families the weak
 * model mostly solves; level 3 = weak fails, strong solves; level 5 = strong struggles too.
 */
export const MIXES: Record<number, string[]> = {
  1: ["sports_understanding", "boolean_expressions", "navigate", "gsm8k"],
  2: ["boolean_expressions", "date_understanding", "gsm8k", "logical_deduction_three_objects", "web_of_lies"],
  3: ["date_understanding", "multistep_arithmetic_two", "word_sorting", "tracking_shuffled_objects_three_objects", "logical_deduction_three_objects", "temporal_sequences"],
  4: ["multistep_arithmetic_two", "word_sorting", "tracking_shuffled_objects_three_objects", "temporal_sequences", "reasoning_about_colored_objects", "object_counting"],
  5: ["multistep_arithmetic_two", "word_sorting", "tracking_shuffled_objects_three_objects", "formal_fallacies", "temporal_sequences"],
};

export function graderFor(item: Item): Grader {
  if (item.kind === "choice") return { type: "choice", value: item.answer };
  if (item.kind === "numeric") return { type: "numeric", value: item.answer, tolerance: /\./.test(item.answer) ? 0.01 : 0 };
  return { type: "exact", value: item.answer };
}

export interface SampleOptions {
  seed: string;
  count: number;
  difficulty: number; // 1..5 -> MIXES
  families?: string[]; // override the mix
}

/** Deterministic, duplicate-free sample of real items, round-robin over the mix's families. */
export function sampleTasks(opts: SampleOptions): Task[] {
  const r = new Rng(opts.seed);
  const fams = opts.families ?? MIXES[Math.min(5, Math.max(1, opts.difficulty))]!;
  const pools = new Map<string, Item[]>();
  for (const f of fams) {
    const pool = allItems().filter((i) => i.family === f);
    if (pool.length === 0) throw new Error(`no items for family ${f}`);
    // Fisher-Yates with the seeded RNG so the same seed always gives the same bundle.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    pools.set(f, pool);
  }
  const tasks: Task[] = [];
  let k = 0;
  while (tasks.length < opts.count) {
    const f = fams[k % fams.length]!;
    const item = pools.get(f)!.pop();
    k++;
    if (!item) continue; // family exhausted, keep cycling the others
    if (k > opts.count * fams.length + 1000) throw new Error("not enough items");
    tasks.push({
      index: tasks.length,
      family: item.family,
      difficulty: opts.difficulty,
      prompt: item.prompt,
      grader: graderFor(item),
      reference: item.answer,
      sourceId: item.id,
    });
  }
  return tasks;
}
