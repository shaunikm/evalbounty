/**
 * Measure what one task costs and how long it takes on the pinned OpenAI pair, from real usage
 * numbers, so bundle sizes can be chosen with a calculator instead of a guess.
 *
 *   pnpm --filter agents exec tsx scripts/cost-probe.ts [--tasks=24] [--difficulty=3] [--concurrency=8]
 *
 * Spends ~2 × tasks calls (a fraction of a cent at nano prices). Prints per-model token usage
 * (prompt / completion / hidden reasoning), latency percentiles, wall time at the chosen
 * concurrency, and the account's rate-limit headers.
 */
import "../src/lib/chain.js"; // loads agents/.env
import { DEFAULT_RUN_PARAMS } from "../src/lib/bundle.js";
import { sampleTasks } from "../src/lib/datasets.js";
import { defaultModels } from "../src/lib/models.js";

const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const N = arg("tasks", 24), DIFF = arg("difficulty", 3), CONC = arg("concurrency", 8);
const { default: OpenAI } = await import("openai");
const client = new OpenAI({ maxRetries: 6 });
const tasks = sampleTasks({ seed: "cost-probe", count: N, difficulty: DIFF });
const models = defaultModels("openai");
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

for (const [role, modelId] of Object.entries(models)) {
  const reasoning = /^(o\d|gpt-5)/.test(modelId);
  const lat: number[] = []; let inTok = 0, outTok = 0, reasonTok = 0, cachedTok = 0; let headers: Record<string, string> = {};
  const t0 = Date.now(); let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const k = i++; if (k >= tasks.length) return;
      const t = tasks[k]! as { prompt?: string; input?: string; question?: string };
      const prompt = t.prompt ?? t.input ?? t.question ?? JSON.stringify(t);
      const s = Date.now();
      const { data: res, response } = await client.chat.completions.create({
        model: modelId,
        messages: [{ role: "system", content: DEFAULT_RUN_PARAMS.system }, { role: "user", content: prompt }],
        max_completion_tokens: reasoning ? DEFAULT_RUN_PARAMS.max_tokens + 4096 : DEFAULT_RUN_PARAMS.max_tokens,
        ...(reasoning ? { reasoning_effort: (process.env.OPENAI_REASONING_EFFORT ?? "low") as "low" } : { temperature: DEFAULT_RUN_PARAMS.temperature }),
      }).withResponse();
      lat.push((Date.now() - s) / 1000);
      inTok += res.usage?.prompt_tokens ?? 0; outTok += res.usage?.completion_tokens ?? 0;
      reasonTok += res.usage?.completion_tokens_details?.reasoning_tokens ?? 0; cachedTok += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      if (!headers["x-ratelimit-limit-requests"]) headers = Object.fromEntries([...response.headers.entries()].filter(([h]) => h.startsWith("x-ratelimit")));
    }
  }));
  const wall = (Date.now() - t0) / 1000;
  console.log(`\n${role.toUpperCase()} ${modelId}  (${N} tasks, difficulty ${DIFF}, concurrency ${CONC})`);
  console.log(`  tokens/task: prompt ${(inTok / N).toFixed(0)} (cached ${(cachedTok / N).toFixed(0)})  completion ${(outTok / N).toFixed(0)}  of which reasoning ${(reasonTok / N).toFixed(0)}`);
  console.log(`  latency s: p50 ${pct(lat, 0.5).toFixed(2)}  p90 ${pct(lat, 0.9).toFixed(2)}  max ${pct(lat, 1).toFixed(2)}   wall ${wall.toFixed(1)}s → ${(wall / N).toFixed(2)} s/task at this concurrency`);
  console.log(`  rate limits: ${JSON.stringify(headers)}`);
}
