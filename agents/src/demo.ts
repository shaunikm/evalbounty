/**
 * Scripted demo on the configured chain (Sepolia by default via agents/.env).
 *
 *   pnpm --filter agents demo                 # all four stories
 *   pnpm --filter agents demo --story=happy   # one of: happy | junk | easy | bad
 *
 * Same code path as the anvil e2e test, just with real block times and Etherscan links.
 */
import { defaultBuyerConfig } from "./buyer.js";
import { loadOrCreateArbiterKeys } from "./deploy.js";
import { env, eth, evalBounty, explorer, log, publicClient, wallet } from "./lib/chain.js";
import { getProvider } from "./lib/models.js";
import { STORIES, prepareArbiter, reputationSummary, type StoryName } from "./stories.js";

const only = process.argv.find((a) => a.startsWith("--story="))?.split("=")[1] as StoryName | undefined;
const names = only ? [only] : (Object.keys(STORIES) as StoryName[]);
if (only && !(only in STORIES)) throw new Error(`unknown story ${only}; pick one of ${Object.keys(STORIES).join(", ")}`);

const provider = await getProvider();
const ctx = {
  provider,
  buyer: wallet(env.key("BUYER_KEY")),
  seller: wallet(env.key("SELLER_KEY")),
  junk: wallet(env.key("JUNK_SELLER_KEY")),
  arbiter: wallet(env.key("ARBITER_KEY")),
  arbiterKp: await loadOrCreateArbiterKeys(),
  cfg: defaultBuyerConfig(),
};
const c = evalBounty();
log("demo", `chain=${env.chainName} EvalBounty=${explorer.address(c.address)} provider=${provider.name}`);
for (const [name, w] of Object.entries({ buyer: ctx.buyer, seller: ctx.seller, junk: ctx.junk, arbiter: ctx.arbiter })) {
  log("demo", `${name.padEnd(7)} ${w.account.address} ${eth(await publicClient().getBalance({ address: w.account.address }))}`);
}
await prepareArbiter(ctx);
for (const name of names) {
  const t = Date.now();
  const id = await STORIES[name](ctx);
  log("demo", `story "${name}" done (bounty #${id}) in ${((Date.now() - t) / 1000).toFixed(0)}s  ${explorer.address(c.address)}#events`);
}
await reputationSummary(ctx);
