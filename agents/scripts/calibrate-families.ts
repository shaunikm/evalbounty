// Measure the pinned weak/strong models on N items of every benchmark family, to set the
// difficulty mixes in src/lib/datasets.ts from data rather than guesswork.
//   pnpm --filter agents calibrate-families -- 12
import "../src/lib/chain.js"; // loads agents/.env
import { bundleCommitment, DEFAULT_RUN_PARAMS, type Bundle } from "../src/lib/bundle.js";
import { families, sampleTasks } from "../src/lib/datasets.js";
import { defaultModels, getProvider, providerName } from "../src/lib/models.js";
import { measureBundle } from "../src/lib/verify.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const n = Number(args[0] ?? 12);
const provider = await getProvider();
const m = defaultModels(providerName());
console.log(`provider ${provider.name}: weak=${m.weak} strong=${m.strong}, ${n} items per family`);
const rows: { family: string; weak: number; strong: number; secs: number }[] = [];
for (const f of families()) {
  const tasks = sampleTasks({ seed: `cal-${f}`, count: n, difficulty: 3, families: [f] });
  const bundle: Bundle = { version: 1, salt: `0x${"00".repeat(32)}`, domainTag: "benchmark-reasoning", runParams: DEFAULT_RUN_PARAMS, tasks, sellerMeasured: { weak: 0, strong: 0, null: 0 } };
  const t0 = Date.now();
  const t = await measureBundle(bundle, { weakModel: m.weak, strongModel: m.strong, weakMaxBps: 0, strongMinBps: 0, nullMaxBps: 0, runs: 1, toleranceBps: 0 }, provider, bundleCommitment(bundle), { concurrency: 8 });
  const secs = (Date.now() - t0) / 1000;
  rows.push({ family: f, weak: t.scores.weak / 100, strong: t.scores.strong / 100, secs });
  console.log(`${f.padEnd(42)} weak ${String(t.scores.weak / 100).padStart(5)}%  strong ${String(t.scores.strong / 100).padStart(5)}%  null ${t.scores.null / 100}%  (${secs.toFixed(0)}s)`);
  const miss = t.perTask.find((r) => r.strong[0] === 0);
  if (miss) console.log(`   strong miss: ${tasks[miss.index]!.sourceId} ref=${JSON.stringify(tasks[miss.index]!.reference)} got=${JSON.stringify(miss.strongAnswers[0]).slice(0, 60)}`);
}
console.log("\nsorted by weak accuracy (easy -> hard for the weak model):");
for (const r of rows.sort((a, b) => b.weak - a.weak)) console.log(`  ${r.family.padEnd(42)} weak ${String(r.weak).padStart(5)}%  strong ${String(r.strong).padStart(5)}%`);
