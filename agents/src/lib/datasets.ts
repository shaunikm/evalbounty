/**
 * Real evaluation items. Bundles are sampled from committed snapshots of public benchmark suites
 * (agents/data/*.json, produced by scripts/fetch-datasets.ts):
 *
 *   - BIG-Bench Hard (Suzgun et al., 2022) — 19 exact-answer reasoning subtasks, MIT
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
 * Difficulty mixes from measured accuracy (12 items/family, 2026-09-11) of the pinned pair
 * gpt-4.1-nano-2025-04-14 (no reasoning) vs gpt-5-nano-2025-08-07 (low reasoning effort):
 *
 *   boolean_expressions 83/100  formal_fallacies 83/100  temporal_sequences 75/100  web_of_lies 75/83
 *   logical_deduction_five 67/100  navigate 58/100  colored_objects 58/92  sports 50/83
 *   logical_deduction_three 50/100  geometric_shapes 50/92  date_understanding 42/92
 *   object_counting 42/92  word_sorting 42/92  tracking_three 33/100  logical_deduction_seven 33/100
 *   gsm8k 25/100  tracking_five 17/100  tracking_seven 8/100  multistep_arithmetic_two 0/100  dyck 0/58
 *
 * Expected weak/strong per level: 1 ≈ 77/97 (dishonest "easy" seller), 2 ≈ 53/93, 3 ≈ 25/98 (honest
 * default for the 35/65 band), 4 ≈ 17/100, 5 ≈ 12/92. Re-measure with `pnpm calibrate-families`.
 */
export const MIXES: Record<number, string[]> = {
  1: ["boolean_expressions", "formal_fallacies", "temporal_sequences", "web_of_lies", "logical_deduction_five_objects"],
  2: ["navigate", "reasoning_about_colored_objects", "sports_understanding", "logical_deduction_three_objects", "geometric_shapes"],
  3: ["gsm8k", "multistep_arithmetic_two", "tracking_shuffled_objects_three_objects", "logical_deduction_seven_objects", "tracking_shuffled_objects_five_objects", "word_sorting"],
  4: ["gsm8k", "multistep_arithmetic_two", "tracking_shuffled_objects_five_objects", "tracking_shuffled_objects_seven_objects", "logical_deduction_seven_objects"],
  5: ["multistep_arithmetic_two", "tracking_shuffled_objects_seven_objects", "tracking_shuffled_objects_five_objects", "dyck_languages", "logical_deduction_seven_objects"],
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
