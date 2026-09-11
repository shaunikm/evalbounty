/**
 * Claim verification. The same routine is run by the seller (to tune and to fill in
 * sellerMeasured), by the buyer (to decide accept vs dispute) and by the arbitrator (to rule).
 *
 * score(model) = mean over tasks of mean over `runs` of grader(answer) in {0,1}, in basis points.
 * Claims hold iff  weak <= weakMax + tol,  strong >= strongMin - tol,  null <= nullMax + tol.
 *
 * Tolerance guidance (Miller, "Adding Error Bars to Evals", 2024): with the task set fixed, the
 * only noise in a rerun is answer resampling, so SE = sqrt(sum_i p_i(1-p_i)/runs) / N. A buyer
 * should set toleranceBps >= 2*SE (in bps) to keep false disputes rare.
 */
import { keccak256, type Hex } from "viem";
import { canonicalBytes, grade, type Bundle, type Task } from "./bundle.js";
import { NULL_MODEL, type ModelProvider } from "./models.js";

export interface ClaimSpec {
  weakModel: string;
  strongModel: string;
  weakMaxBps: number;
  strongMinBps: number;
  nullMaxBps: number;
  runs: number;
  toleranceBps: number;
}

export interface Scores {
  weak: number;
  strong: number;
  null: number;
}

export interface TaskRecord {
  index: number;
  weak: number[];
  strong: number[];
  null: number[];
  weakAnswers: string[];
  strongAnswers: string[];
}

export interface Transcript {
  provider: string;
  bundleCommitment: Hex;
  models: { weak: string; strong: string; null: string };
  runs: number;
  perTask: TaskRecord[];
  scores: Scores;
  standardErrorBps: { weak: number; strong: number };
}

export interface MeasureOptions {
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
}

const toBps = (x: number) => Math.round(x * 10_000);

async function scoreTask(provider: ModelProvider, modelId: string, task: Task, bundle: Bundle, runs: number) {
  const results: number[] = [];
  const answers: string[] = [];
  for (let run = 0; run < runs; run++) {
    let answer = "";
    try {
      answer = await provider.complete(modelId, task.prompt, bundle.runParams, { task, run });
    } catch (err) {
      answer = `<error: ${(err as Error).message}>`;
    }
    answers.push(answer);
    results.push(grade(task, answer));
  }
  return { results, answers };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Standard error of a mean-of-task-means when only answers are resampled. */
export function resamplingStandardError(perTaskMeans: number[], runs: number): number {
  const n = perTaskMeans.length;
  if (n === 0) return 0;
  const sum = perTaskMeans.reduce((acc, p) => acc + (p * (1 - p)) / runs, 0);
  return Math.sqrt(sum) / n;
}

export async function measureBundle(
  bundle: Bundle,
  spec: ClaimSpec,
  provider: ModelProvider,
  bundleCommitment: Hex,
  opts: MeasureOptions = {},
): Promise<Transcript> {
  const perTask: TaskRecord[] = [];
  const total = bundle.tasks.length;
  const concurrency = Math.max(1, opts.concurrency ?? (provider.name === "mock" ? 16 : 8));
  let done = 0;
  const queue = [...bundle.tasks];
  const worker = async () => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      const [w, s, z] = await Promise.all([
        scoreTask(provider, spec.weakModel, task, bundle, spec.runs),
        scoreTask(provider, spec.strongModel, task, bundle, spec.runs),
        scoreTask(provider, NULL_MODEL, task, bundle, 1),
      ]);
      perTask.push({
        index: task.index,
        weak: w.results,
        strong: s.results,
        null: z.results,
        weakAnswers: w.answers,
        strongAnswers: s.answers,
      });
      opts.onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  perTask.sort((a, b) => a.index - b.index);

  const weakMeans = perTask.map((t) => mean(t.weak));
  const strongMeans = perTask.map((t) => mean(t.strong));
  const nullMeans = perTask.map((t) => mean(t.null));
  const scores: Scores = {
    weak: toBps(mean(weakMeans)),
    strong: toBps(mean(strongMeans)),
    null: toBps(mean(nullMeans)),
  };
  return {
    provider: provider.name,
    bundleCommitment,
    models: { weak: spec.weakModel, strong: spec.strongModel, null: NULL_MODEL },
    runs: spec.runs,
    perTask,
    scores,
    standardErrorBps: {
      weak: toBps(resamplingStandardError(weakMeans, spec.runs)),
      strong: toBps(resamplingStandardError(strongMeans, spec.runs)),
    },
  };
}

export interface ClaimVerdict {
  ok: boolean;
  reasons: string[];
}

export const fmt = (bps: number) => `${(bps / 100).toFixed(1)}%`;

export function claimsHold(scores: Scores, spec: ClaimSpec): ClaimVerdict {
  const tol = spec.toleranceBps;
  const reasons: string[] = [];
  if (scores.weak > spec.weakMaxBps + tol) {
    reasons.push(`weak model scored ${fmt(scores.weak)} > ${fmt(spec.weakMaxBps)} + ${fmt(tol)} tolerance (tasks too easy)`);
  }
  if (scores.strong < spec.strongMinBps - tol) {
    reasons.push(
      `strong model scored ${fmt(scores.strong)} < ${fmt(spec.strongMinBps)} - ${fmt(tol)} tolerance (no headroom / unsolvable)`,
    );
  }
  if (scores.null > spec.nullMaxBps + tol) {
    reasons.push(`null policy scored ${fmt(scores.null)} > ${fmt(spec.nullMaxBps)} + ${fmt(tol)} tolerance (grader is trivial)`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Strict version (no tolerance) used by the seller when tuning, so its claims sit inside the band with margin. */
export function insideBand(scores: Scores, spec: ClaimSpec): boolean {
  return scores.weak <= spec.weakMaxBps && scores.strong >= spec.strongMinBps && scores.null <= spec.nullMaxBps;
}

export function transcriptHash(t: Transcript): Hex {
  return keccak256(canonicalBytes(t));
}
