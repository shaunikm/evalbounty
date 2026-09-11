// Vercel build step: write dashboard/config.js from project environment variables when they are set,
// so a deployment is configured in Vercel (Settings → Environment Variables), not by editing files.
// Without the variables, the committed config.js (written by `pnpm --filter agents deploy-contracts`)
// is left untouched. Required to override: EVALBOUNTY_ADDRESS. Optional: ARBITRATOR_ADDRESS,
// DEPLOY_BLOCK, CHAIN_ID (default 11155111), RPC_URL, AGENT_BUYER/SELLER/ARBITER/JUNK (labels).
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const e = process.env;
if (!e.EVALBOUNTY_ADDRESS) {
  console.log("build-config: EVALBOUNTY_ADDRESS not set; keeping committed config.js");
  process.exit(0);
}
const chainId = Number(e.CHAIN_ID ?? 11155111);
const agents = {};
for (const [k, v] of Object.entries({ buyer: e.AGENT_BUYER, seller: e.AGENT_SELLER, arbiter: e.AGENT_ARBITER, junkSeller: e.AGENT_JUNK })) if (v) agents[k] = v;
const cfg = {
  chainId,
  contractAddress: e.EVALBOUNTY_ADDRESS,
  arbitratorAddress: e.ARBITRATOR_ADDRESS ?? null,
  deployBlock: Number(e.DEPLOY_BLOCK ?? 0),
  rpcUrl: e.RPC_URL ?? null, // null -> the page uses the chain's default public RPC
  arbiterPubKey: e.ARBITER_PUBKEY ?? null,
  agents,
};
writeFileSync(resolve(here, "config.js"), `// Generated at build time from environment variables (dashboard/build-config.mjs)\nwindow.EVALBOUNTY_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log(`build-config: wrote config.js for ${cfg.contractAddress} on chain ${chainId}`);
