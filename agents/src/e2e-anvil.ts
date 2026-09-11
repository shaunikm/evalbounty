/**
 * End-to-end regression on a fresh anvil: deploy, then run all four stories with the mock
 * provider. Exits non-zero if any expected state is not reached.
 *
 *   pnpm --filter agents e2e
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const keep = process.argv.includes("--keep"); // leave anvil running and write dashboard/config.local.js
const noSpawn = process.argv.includes("--no-spawn"); // use an anvil that is already running on ANVIL_PORT

// Anvil's well-known dev accounts. Set BEFORE importing anything that reads env.
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;
const PORT = process.env.ANVIL_PORT ?? "8546";
process.env.CHAIN = "anvil";
process.env.RPC_URL = `http://127.0.0.1:${PORT}`;
process.env.MODEL_PROVIDER = process.env.MODEL_PROVIDER ?? "mock";
process.env.DEPLOYER_KEY = ANVIL_KEYS[0];
process.env.BUYER_KEY = ANVIL_KEYS[1];
process.env.SELLER_KEY = ANVIL_KEYS[2];
process.env.ARBITER_KEY = ANVIL_KEYS[3];
process.env.JUNK_SELLER_KEY = ANVIL_KEYS[4];
delete process.env.EVALBOUNTY_ADDRESS;
delete process.env.ARBITRATOR_ADDRESS;

const { deploy } = await import("./deploy.js");
const { env, log, publicClient, resetClients, wallet } = await import("./lib/chain.js");
const { getProvider } = await import("./lib/models.js");
const { defaultBuyerConfig } = await import("./buyer.js");
const { STORIES, reputationSummary } = await import("./stories.js");

async function waitForRpc(timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      await publicClient().getBlockNumber({ cacheTime: 0 });
      return;
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const anvil = noSpawn ? null : spawn("anvil", ["--port", PORT, "--block-time", "1", "--silent"], { stdio: "ignore", detached: keep });
anvil?.on("error", (e) => {
  console.error("failed to start anvil (is Foundry installed?)", e);
  process.exit(2);
});
if (keep) anvil?.unref();
let failed = false;
try {
  await waitForRpc();
  resetClients();
  log("e2e", `anvil up on :${PORT}, chain=${env.chainName}`);
  const dep = await deploy({ fund: false, persist: false });
  const provider = await getProvider();
  const ctx = {
    provider,
    buyer: wallet(env.key("BUYER_KEY")),
    seller: wallet(env.key("SELLER_KEY")),
    junk: wallet(env.key("JUNK_SELLER_KEY")),
    arbiter: wallet(env.key("ARBITER_KEY")),
    arbiterKp: dep.arbiterKp,
    cfg: defaultBuyerConfig(),
  };
  const only = process.argv.find((a) => a.startsWith("--story="))?.split("=")[1];
  for (const [name, story] of Object.entries(STORIES)) {
    if (only && only !== name) continue;
    const t = Date.now();
    await story(ctx);
    log("e2e", `story "${name}" passed in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  await reputationSummary(ctx);
  if (keep) {
    const cfg = `window.EVALBOUNTY_CONFIG = ${JSON.stringify({ chainId: 31337, contractAddress: dep.evalBountyAddress, arbitratorAddress: dep.arbitratorAddress, deployBlock: Number(dep.deployBlock), rpcUrl: process.env.RPC_URL, explorerBase: "", arbiterPubKey: dep.arbiterKp.publicKey, agents: { buyer: ctx.buyer.account.address, seller: ctx.seller.account.address, arbiter: ctx.arbiter.account.address, junkSeller: ctx.junk.account.address } }, null, 2)};\n`;
    writeFileSync(new URL("../../dashboard/config.local.js", import.meta.url), cfg);
    log("e2e", `wrote dashboard/config.local.js (anvil on :${PORT} left running)`);
  }
  log("e2e", "ALL STORIES PASSED");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  if (!keep) anvil?.kill();
}
process.exit(failed ? 1 : 0);
