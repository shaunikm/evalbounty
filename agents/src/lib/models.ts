/**
 * Model providers. `provider.complete(modelId, prompt, runParams, ctx)` returns the raw answer.
 *
 *  - mock       deterministic, needs no key: answers correctly with a probability that depends on
 *               the model id and the task's difficulty, and can only guess on unanswerable prompts.
 *               The same (model, prompt, run) always yields the same answer, so buyer and arbiter
 *               reruns reproduce the seller's numbers exactly. Lets the whole lifecycle run on anvil.
 *  - anthropic  Claude via @anthropic-ai/sdk (ANTHROPIC_API_KEY).
 *  - openai     OpenAI chat completions via the openai package (OPENAI_API_KEY).
 */
import { keccak256, toHex } from "viem";
import type { RunParams, Task } from "./bundle.js";
import { UNANSWERABLE } from "./generators.js";

export const NULL_MODEL = "null-policy";
/** The trivial baseline: always answer "0". Catches graders that accept anything. */
export const NULL_ANSWER = "0";

export interface CallContext {
  task: Task;
  run: number;
}

export interface ModelProvider {
  readonly name: string;
  complete(modelId: string, prompt: string, runParams: RunParams, ctx: CallContext): Promise<string>;
}

// ------------------------------------------------------------------ mock

function unit(...parts: (string | number)[]): number {
  const h = keccak256(toHex(parts.join("|")));
  return Number(BigInt(h) & 0xffffffffffffn) / 2 ** 48;
}

export function mockWrongProbability(modelId: string, difficulty: number): number {
  const id = modelId.toLowerCase();
  if (id === NULL_MODEL) return 1;
  // difficulty 1..5 -> weak answers correctly 62%, 44%, 26%, 8%, 3%; strong 92%, 86%, 80%, 74%, 68%
  if (/weak|haiku|mini|nano|small|3\.5|4o-mini/.test(id)) return Math.min(0.97, 0.2 + 0.18 * difficulty);
  if (/strong|sonnet|opus|gpt|o[134]|large|pro/.test(id)) return Math.min(0.9, 0.02 + 0.06 * difficulty);
  return 0.5;
}

function wrongAnswer(task: Task, u: number): string {
  const ref = task.reference;
  if (task.grader.type === "choice") {
    const letters = "ABCDEF".replace(ref.toUpperCase(), "");
    return `(${letters[Math.floor(u * letters.length)]})`;
  }
  if (task.grader.type === "numeric") {
    const n = Number(ref);
    if (Number.isFinite(n) && Number.isInteger(n)) {
      const delta = 1 + Math.floor(u * 97);
      return String(n + (u < 0.5 ? delta : -delta));
    }
    return (n * (1.05 + u * 0.4)).toFixed(2);
  }
  // string: rotate by a non-zero amount, guaranteed different for len > 1
  const k = 1 + Math.floor(u * Math.max(1, ref.length - 1));
  const rotated = ref.slice(k) + ref.slice(0, k);
  return rotated === ref ? ref + "x" : rotated;
}

export const mockProvider: ModelProvider = {
  name: "mock",
  async complete(modelId, prompt, _runParams, ctx) {
    if (modelId === NULL_MODEL) return NULL_ANSWER;
    const u = unit(modelId, prompt, ctx.run);
    if (UNANSWERABLE.test(prompt)) return String(1 + Math.floor(u * 1_000_000)); // a real model can only guess
    if (u < mockWrongProbability(modelId, ctx.task.difficulty)) return wrongAnswer(ctx.task, u);
    return ctx.task.reference;
  },
};

// ------------------------------------------------------------------ anthropic

async function anthropicProvider(): Promise<ModelProvider> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ maxRetries: 6 });
  return {
    name: "anthropic",
    async complete(modelId, prompt, runParams) {
      if (modelId === NULL_MODEL) return NULL_ANSWER;
      // Sampling parameters are rejected on Claude 4.6+ / 5 models; only pre-4.6 (e.g. Haiku 4.5) take temperature.
      const acceptsTemperature = /haiku-4-5|-4-5|-4-1|-3-/.test(modelId);
      // Adaptive thinking counts toward max_tokens on 4.6+/5 models: give it room, keep effort low.
      const reasoning = !acceptsTemperature;
      const res = await client.messages.create({
        model: modelId,
        max_tokens: reasoning ? runParams.max_tokens + 2048 : runParams.max_tokens,
        system: runParams.system,
        messages: [{ role: "user", content: prompt }],
        ...(acceptsTemperature ? { temperature: runParams.temperature } : {}),
        ...(reasoning ? { output_config: { effort: "low" as const } } : {}),
      });
      if (res.stop_reason === "refusal") return "";
      return res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
    },
  };
}

// ------------------------------------------------------------------ openai

async function openaiProvider(): Promise<ModelProvider> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ maxRetries: 6 }); // ride out 429s at concurrency 8
  return {
    name: "openai",
    async complete(modelId, prompt, runParams) {
      if (modelId === NULL_MODEL) return NULL_ANSWER;
      const reasoningModel = /^(o\d|gpt-5)/.test(modelId);
      const effort = (process.env.OPENAI_REASONING_EFFORT ?? "low") as "minimal" | "low" | "medium" | "high";
      const res = await client.chat.completions.create({
        model: modelId,
        messages: [
          { role: "system", content: runParams.system },
          { role: "user", content: prompt },
        ],
        // reasoning models spend hidden tokens before answering and reject sampling params
        max_completion_tokens: reasoningModel ? runParams.max_tokens + 4096 : runParams.max_tokens,
        ...(reasoningModel ? { reasoning_effort: effort } : { temperature: runParams.temperature }),
      });
      return (res.choices[0]?.message?.content ?? "").trim();
    },
  };
}

// ------------------------------------------------------------------ spend guard

/** Hard cap on paid model calls per process so a bug or a hostile counterparty cannot drain credits. */
export const MODEL_CALL_BUDGET = Number(process.env.MODEL_CALL_BUDGET ?? 3000);

export function withBudget(p: ModelProvider, budget = MODEL_CALL_BUDGET): ModelProvider {
  let calls = 0;
  return {
    name: p.name,
    async complete(modelId, prompt, runParams, ctx) {
      if (++calls > budget) {
        throw new Error(`model call budget of ${budget} exhausted for this process (raise MODEL_CALL_BUDGET if intended)`);
      }
      return p.complete(modelId, prompt, runParams, ctx);
    },
  };
}

// ------------------------------------------------------------------ selection

export function providerName(): string {
  const v = (process.env.MODEL_PROVIDER ?? "").trim();
  return v === "" ? "mock" : v;
}

export async function getProvider(name = providerName()): Promise<ModelProvider> {
  switch (name) {
    case "mock":
      return mockProvider;
    case "anthropic":
      return withBudget(await anthropicProvider());
    case "openai":
      return withBudget(await openaiProvider());
    default:
      throw new Error(`unknown MODEL_PROVIDER ${name}`);
  }
}

/** Sensible pinned model ids per provider for the weak/strong pair. */
export function defaultModels(provider: string): { weak: string; strong: string } {
  if (provider === "anthropic") return { weak: "claude-haiku-4-5", strong: "claude-sonnet-5" };
  // Cheapest pair with a real capability gap: a non-reasoning nano vs a reasoning nano (pinned snapshots).
  if (provider === "openai") return { weak: "gpt-4.1-nano-2025-04-14", strong: "gpt-5-nano-2025-08-07" };
  return { weak: "mock-weak", strong: "mock-strong" };
}
