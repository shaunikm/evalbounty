// Measure real-model scores per difficulty and family to choose the demo band.
//   pnpm --filter agents calibrate -- 1,3 1        (difficulties, runs)
import { bundleCommitment, DEFAULT_RUN_PARAMS, type Bundle } from "../src/lib/bundle.js";
import { generateTasks } from "../src/lib/generators.js";
import { defaultModels, getProvider, providerName } from "../src/lib/models.js";
import { measureBundle } from "../src/lib/verify.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const diffs = (args[0] ?? "1,3").split(",").map(Number);
const runs = Number(args[1] ?? 1);
const provider = await getProvider();
const m = defaultModels(providerName());
console.log(`provider ${provider.name}: weak=${m.weak} strong=${m.strong} runs=${runs}`);
for (const d of diffs) {
  const tasks = generateTasks({ seed: `cal-${d}`, count: 30, difficulty: d });
  const bundle: Bundle = { version: 1, salt: `0x${"00".repeat(32)}`, domainTag: "exact-answer-reasoning", runParams: DEFAULT_RUN_PARAMS, tasks, sellerMeasured: { weak: 0, strong: 0, null: 0 } };
  const t0 = Date.now();
  const t = await measureBundle(bundle, { weakModel: m.weak, strongModel: m.strong, weakMaxBps: 0, strongMinBps: 0, nullMaxBps: 0, runs, toleranceBps: 0 }, provider, bundleCommitment(bundle), {
    concurrency: 8,
    onProgress: (a, b) => process.stdout.write(`\r  ${a}/${b} tasks`),
  });
  console.log(`\ndifficulty ${d}: weak ${t.scores.weak / 100}%  strong ${t.scores.strong / 100}%  null ${t.scores.null / 100}%   (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const fam: Record<string, { w: number[]; s: number[] }> = {};
  for (const r of t.perTask) {
    const f = tasks[r.index]!.family;
    fam[f] ??= { w: [], s: [] };
    fam[f].w.push(...r.weak);
    fam[f].s.push(...r.strong);
  }
  const pct = (xs: number[]) => `${((100 * xs.reduce((a, b) => a + b, 0)) / Math.max(1, xs.length)).toFixed(0)}%`;
  for (const [f, v] of Object.entries(fam)) console.log(`   ${f.padEnd(9)} weak ${pct(v.w).padStart(4)}  strong ${pct(v.s).padStart(4)}`);
  for (const r of t.perTask.filter((r) => r.strong[0] === 0).slice(0, 4)) {
    console.log(`   strong miss: task ${r.index} [${tasks[r.index]!.family}] ref=${tasks[r.index]!.reference} got=${JSON.stringify(r.strongAnswers[0]).slice(0, 70)}`);
  }
}
