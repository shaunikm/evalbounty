/**
 * Snapshot real evaluation items into agents/data/*.json (committed) so sellers sample from
 * actual benchmark suites and CI stays deterministic/offline.
 *
 * Sources (verified 2026-09-11):
 *  - BIG-Bench Hard (Suzgun et al., 2022), MIT, https://github.com/suzgunmirac/BIG-Bench-Hard
 *  - GSM8K test split (Cobbe et al., 2021), MIT, https://github.com/openai/grade-school-math
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../data");
mkdirSync(out, { recursive: true });

export type Kind = "choice" | "numeric" | "exact";
export interface Item {
  id: string; // source-specific stable id
  family: string; // bbh subtask or "gsm8k"
  kind: Kind;
  prompt: string;
  answer: string;
}

const BBH_BASE = "https://raw.githubusercontent.com/suzgunmirac/BIG-Bench-Hard/main/bbh/";
const BBH_TASKS = [
  "boolean_expressions",
  "date_understanding",
  "multistep_arithmetic_two",
  "navigate",
  "object_counting",
  "sports_understanding",
  "word_sorting",
  "tracking_shuffled_objects_three_objects",
  "logical_deduction_three_objects",
  "temporal_sequences",
  "web_of_lies",
  "reasoning_about_colored_objects",
  "formal_fallacies",
  "tracking_shuffled_objects_five_objects",
  "tracking_shuffled_objects_seven_objects",
  "logical_deduction_five_objects",
  "logical_deduction_seven_objects",
  "dyck_languages",
  "geometric_shapes",
];
const GSM8K_URL = "https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function instruction(kind: Kind, family: string): string {
  if (kind === "choice") return "Reply with only the letter of the correct option in parentheses, e.g. (B).";
  if (kind === "numeric") return "Reply with only the final integer.";
  if (family === "word_sorting") return "Reply with only the sorted words separated by single spaces.";
  if (family === "dyck_languages") return "Reply with only the closing brackets needed, separated by single spaces.";
  if (family === "boolean_expressions") return "Reply with only True or False.";
  if (family === "formal_fallacies") return "Reply with only valid or invalid.";
  if (["web_of_lies", "sports_understanding", "navigate"].includes(family)) return "Reply with only Yes or No.";
  return "Reply with only the final answer.";
}

function kindOf(target: string): Kind {
  if (/^\([A-Z]\)$/.test(target)) return "choice";
  if (/^-?\d+$/.test(target)) return "numeric";
  return "exact";
}

async function get(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

const sources: Record<string, unknown>[] = [];
const bbhItems: Item[] = [];
for (const task of BBH_TASKS) {
  const url = BBH_BASE + task + ".json";
  const raw = await get(url);
  const json = JSON.parse(raw) as { examples: { input: string; target: string }[] };
  let n = 0;
  for (const [i, ex] of json.examples.entries()) {
    const target = ex.target.trim();
    const kind = kindOf(target);
    // Skip the rare multi-answer / empty targets so every item has one unambiguous key.
    if (!target || target.includes("\n")) continue;
    bbhItems.push({
      id: `bbh/${task}/${i}`,
      family: task,
      kind,
      prompt: `${ex.input.trim()}\n\n${instruction(kind, task)}`,
      answer: kind === "choice" ? target.slice(1, 2) : target,
    });
    n++;
  }
  sources.push({ name: `bbh/${task}`, url, sha256: sha(raw), items: n, license: "MIT (suzgunmirac/BIG-Bench-Hard)" });
  console.log(`bbh ${task.padEnd(42)} ${String(n).padStart(4)} items  kind=${kindOf(json.examples[0]!.target.trim())}`);
}
writeFileSync(resolve(out, "bbh.json"), JSON.stringify({ source: "BIG-Bench Hard", citation: "Suzgun et al., 2022, arXiv:2210.09261", items: bbhItems }));

const gsmRaw = await get(GSM8K_URL);
const gsmItems: Item[] = [];
for (const [i, line] of gsmRaw.split("\n").filter(Boolean).entries()) {
  const row = JSON.parse(line) as { question: string; answer: string };
  const m = row.answer.match(/####\s*([-\d,\.]+)/);
  if (!m) continue;
  const ans = m[1]!.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(ans)) continue;
  gsmItems.push({ id: `gsm8k/test/${i}`, family: "gsm8k", kind: "numeric", prompt: `${row.question.trim()}\n\nReply with only the final number.`, answer: ans });
}
sources.push({ name: "gsm8k/test", url: GSM8K_URL, sha256: sha(gsmRaw), items: gsmItems.length, license: "MIT (openai/grade-school-math)" });
writeFileSync(resolve(out, "gsm8k.json"), JSON.stringify({ source: "GSM8K test split", citation: "Cobbe et al., 2021, arXiv:2110.14168", items: gsmItems }));
console.log(`gsm8k ${" ".repeat(38)} ${String(gsmItems.length).padStart(4)} items`);

writeFileSync(resolve(out, "SOURCES.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), sources }, null, 2));
console.log(`wrote agents/data/{bbh,gsm8k,SOURCES}.json`);
