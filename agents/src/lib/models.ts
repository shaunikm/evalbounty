/**
 * Model providers, routed per model id so one agent can serve bounties that pin models from
 * different vendors:
 *
 *   claude-*                      -> anthropic (@anthropic-ai/sdk, ANTHROPIC_API_KEY)
 *   gpt-*, o1/o3/o4*, chatgpt-*    -> openai    (openai, OPENAI_API_KEY)
 *   mock-*                        -> mock      (deterministic, keyless; used by tests and anvil e2e)
 *
 * MODEL_PROVIDER=mock forces everything through the mock (CI, e2e). MODEL_PROVIDER=auto (default)
 * routes by id. Paid providers are wrapped in a per-process call budget (MODEL_CALL_BUDGET) so no
 * loop or hostile counterparty can drain credits.
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

export type Vendor = "mock" | "anthropic" | "openai";

/** Which vendor serves a model id, or null if we do not recognise it. */
export function vendorForModel(modelId: string): Vendor | null {
  const id = modelId.toLowerCase();
  if (id === NULL_MODEL || id.startsWith("mock")) return "mock";
  if (id.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o\d|chatgpt-)/.test(id)) return "openai";
  return null;
}

/** MODEL_PROVIDER: "auto" (default) routes by model id; "mock" forces the mock; a vendor name pins the default pair. */
export function forcedProvider(): "mock" | "anthropic" | "openai" | "auto" {
  const v = (process.env.MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (v === "" || v === "auto") return "auto";
  if (v === "mock" || v === "anthropic" || v === "openai") return v;
  throw new Error(`unknown MODEL_PROVIDER "${v}" (mock | anthropic | openai | auto)`);
}

/** True if this process has what it needs (a key, or the mock) to run the model id. */
export function canRunModel(modelId: string): boolean {
  if (forcedProvider() === "mock") return true;
  const v = vendorForModel(modelId);
  if (v === "mock") return true;
  if (v === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (v === "openai") return !!process.env.OPENAI_API_KEY;
  return false;
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

// ------------------------------------------------------------------ routing

/** Vendor whose default pair the demo buyer pins, and the label used in logs. */
export function providerName(): string {
  const f = forcedProvider();
  if (f !== "auto") return f;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "mock";
}

const vendorCache = new Map<Vendor, Promise<ModelProvider>>();
async function vendorProvider(v: Vendor): Promise<ModelProvider> {
  if (v === "mock") return mockProvider;
  if (!vendorCache.has(v)) vendorCache.set(v, (v === "anthropic" ? anthropicProvider() : openaiProvider()).then((p) => withBudget(p)));
  return vendorCache.get(v)!;
}

/** A provider that dispatches each call to the vendor implied by the model id. */
export async function getProvider(): Promise<ModelProvider> {
  if (forcedProvider() === "mock") return mockProvider;
  return {
    name: providerName(),
    async complete(modelId, prompt, runParams, ctx) {
      if (modelId === NULL_MODEL) return NULL_ANSWER;
      const v = vendorForModel(modelId);
      if (!v) throw new Error(`no provider for model id "${modelId}"`);
      if (!canRunModel(modelId)) throw new Error(`cannot run "${modelId}": missing API key for ${v}`);
      return (await vendorProvider(v)).complete(modelId, prompt, runParams, ctx);
    },
  };
}

/** Pinned weak/strong pair used by the demo buyer for a vendor. Cheapest pair with a real capability gap. */
export function defaultModels(vendor: string = providerName()): { weak: string; strong: string } {
  if (vendor === "anthropic") return { weak: "claude-haiku-4-5", strong: "claude-sonnet-5" };
  if (vendor === "openai") return { weak: "gpt-4.1-nano-2025-04-14", strong: "gpt-5-nano-2025-08-07" };
  return { weak: "mock-weak", strong: "mock-strong" };
}
