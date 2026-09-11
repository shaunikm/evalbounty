import { afterEach, describe, expect, it } from "vitest";
import { deriveKeyPair, deriveBytes32, publicKeyFromSecret } from "../src/lib/crypto.js";
import { canRunModel, forcedProvider, vendorForModel } from "../src/lib/models.js";

const SECRET = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil dev key #1

describe("deterministic keys", () => {
  it("same wallet + context -> same keypair; different context -> unrelated", async () => {
    const a = await deriveKeyPair(SECRET, "evalbounty/v1/buyer/31337/0xabc/7");
    const b = await deriveKeyPair(SECRET, "evalbounty/v1/buyer/31337/0xabc/7");
    const c = await deriveKeyPair(SECRET, "evalbounty/v1/buyer/31337/0xabc/8");
    expect(a).toEqual(b);
    expect(a.publicKey).not.toBe(c.publicKey);
    expect((await publicKeyFromSecret(a.secretKey)).toLowerCase()).toBe(a.publicKey.toLowerCase());
    expect(await deriveBytes32(SECRET, "salt/1")).toBe(await deriveBytes32(SECRET, "salt/1"));
    expect(await deriveBytes32(SECRET, "salt/1")).not.toBe(await deriveBytes32(SECRET, "salt/2"));
  });
});

describe("provider routing", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("routes by model id", () => {
    expect(vendorForModel("claude-haiku-4-5")).toBe("anthropic");
    expect(vendorForModel("gpt-4.1-nano-2025-04-14")).toBe("openai");
    expect(vendorForModel("o4-mini")).toBe("openai");
    expect(vendorForModel("mock-weak")).toBe("mock");
    expect(vendorForModel("llama-3")).toBeNull();
  });
  it("canRunModel depends on keys unless the mock is forced", () => {
    process.env.MODEL_PROVIDER = "auto";
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(canRunModel("gpt-4.1-nano")).toBe(false);
    expect(canRunModel("mock-strong")).toBe(true);
    process.env.OPENAI_API_KEY = "sk-test";
    expect(canRunModel("gpt-4.1-nano")).toBe(true);
    expect(canRunModel("claude-sonnet-5")).toBe(false);
    process.env.MODEL_PROVIDER = "mock";
    expect(forcedProvider()).toBe("mock");
    expect(canRunModel("claude-sonnet-5")).toBe(true);
    process.env.MODEL_PROVIDER = "bogus";
    expect(() => forcedProvider()).toThrow();
  });
});
