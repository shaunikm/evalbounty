/**
 * The four scripted stories, driven step by step (no polling races). Used by e2e-anvil.ts as a
 * regression test and by demo.ts on Sepolia for the video.
 *
 *   happy   honest seller -> sample approved -> claims reproduce -> Settled
 *   junk    junk seller   -> sample rejected -> bounty reopens -> honest seller completes it
 *   easy    dishonest seller ships easy tasks but claims the band -> ClaimsFailed dispute -> arbiter rules for buyer
 *   bad     seller delivers garbage ciphertext -> BadDelivery dispute -> arbiter rules for buyer
 */
import { bytesToHex, type Hex } from "viem";
import { arbitrate, arbiterRule } from "./arbiter.js";
import { buyerJudge, buyerVerify, createBounty, type BuyerConfig } from "./buyer.js";
import { DisputeKind, Status, StatusName, eth, evalBounty, log, short, tx, type Wallet } from "./lib/chain.js";
import type { KeyPairHex } from "./lib/crypto.js";
import type { ModelProvider } from "./lib/models.js";
import { prepareBundle, sellerCommit, sellerDeliver, sellerReveal, withdrawIfAny } from "./seller.js";

export interface Ctx {
  provider: ModelProvider;
  buyer: Wallet;
  seller: Wallet;
  junk: Wallet;
  arbiter: Wallet;
  arbiterKp: KeyPairHex;
  cfg: BuyerConfig;
}

export function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`STORY ASSERTION FAILED: ${msg}`);
}

async function status(id: bigint) {
  const b = await evalBounty().read.getBounty([id]);
  return b.status as number;
}

async function expectStatus(id: bigint, want: number) {
  const got = await status(id);
  expect(got === want, `bounty #${id} is ${StatusName[got]}, expected ${StatusName[want]}`);
  log("story", `✔ bounty #${id} is ${StatusName[got]}`);
}

async function honestFulfil(ctx: Ctx, id: bigint) {
  const prep = await prepareBundle((await evalBounty().read.getBounty([id])).spec, ctx.provider, { seed: `seller-${ctx.seller.account.address}-${id}` });
  await sellerCommit(ctx.seller, id, prep);
  await sellerReveal(ctx.seller, id, prep);
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(j.verdict.approve, "buyer should approve an honest sample");
  await sellerDeliver(ctx.seller, id, prep);
  const v = await buyerVerify(ctx.buyer, id, ctx.provider);
  expect(v.verdict.action === "accept", `buyer should accept an honest delivery, got ${JSON.stringify(v.verdict)}`);
  await expectStatus(id, Status.Settled);
}

export async function storyHappy(ctx: Ctx) {
  log("story", "━━ 1/4 happy path: honest seller, honest buyer");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  await honestFulfil(ctx, id);
  const c = evalBounty();
  const owedSeller = await c.read.pending([ctx.seller.account.address]);
  log("story", `seller can withdraw ${eth(owedSeller)} (reward − 2% fee + bond)`);
  await withdrawIfAny(ctx.seller, "seller");
  return id;
}

export async function storyJunk(ctx: Ctx) {
  log("story", "━━ 2/4 junk seller: unanswerable prompts, caught by the random sample");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  const spec = (await evalBounty().read.getBounty([id])).spec;
  const prep = await prepareBundle(spec, ctx.provider, { seed: `junk-${id}`, junk: true, who: "junk" });
  await sellerCommit(ctx.junk, id, prep, "junk");
  await sellerReveal(ctx.junk, id, prep, "junk");
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(!j.verdict.approve, "buyer should reject junk");
  await expectStatus(id, Status.Open);
  const rep = await evalBounty().read.sellerRep([ctx.junk.account.address]);
  log("story", `junk seller reputation: samplesRejected=${rep[1]} (bond returned, no slash — rejection is subjective)`);
  log("story", "bounty reopened; the honest seller picks it up");
  await honestFulfil(ctx, id);
  await withdrawIfAny(ctx.junk, "junk");
  return id;
}

export async function storyEasy(ctx: Ctx) {
  log("story", "━━ 3/4 dishonest seller: well-posed but too-easy tasks, claims the band anyway");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  const spec = (await evalBounty().read.getBounty([id])).spec;
  const prep = await prepareBundle(spec, ctx.provider, { seed: `easy-${id}`, forceDifficulty: 1, who: "seller" });
  await sellerCommit(ctx.seller, id, prep);
  await sellerReveal(ctx.seller, id, prep);
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(j.verdict.approve, "sample of easy-but-valid tasks passes the objective checks (difficulty is not visible from 4 tasks)");
  await sellerDeliver(ctx.seller, id, prep);
  const v = await buyerVerify(ctx.buyer, id, ctx.provider);
  expect(v.verdict.action === "dispute" && v.verdict.kind === DisputeKind.ClaimsFailed, `expected ClaimsFailed dispute, got ${JSON.stringify(v.verdict.action)}`);
  await expectStatus(id, Status.Disputed);
  const b = await evalBounty().read.getBounty([id]);
  const decision = await arbitrate(id, ctx.provider, ctx.arbiterKp);
  await arbiterRule(ctx.arbiter, b.disputeId, decision);
  await expectStatus(id, Status.Refunded);
  const owed = await evalBounty().read.pending([ctx.buyer.account.address]);
  expect(owed >= b.reward + b.disputeBond + b.sellerBond, "buyer gets reward + own bond + seller bond");
  log("story", `buyer recovers ${eth(owed)}: reward + dispute bond + the seller's slashed bond`);
  await withdrawIfAny(ctx.buyer, "buyer");
  return id;
}

export async function storyBadDelivery(ctx: Ctx) {
  log("story", "━━ 4/4 bad delivery: seller posts garbage ciphertext after an approved sample");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  const spec = (await evalBounty().read.getBounty([id])).spec;
  const prep = await prepareBundle(spec, ctx.provider, { seed: `bad-${id}` });
  await sellerCommit(ctx.seller, id, prep);
  await sellerReveal(ctx.seller, id, prep);
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(j.verdict.approve, "sample is fine");
  const garbage = new Uint8Array(200);
  crypto.getRandomValues(garbage);
  log("seller", "(malicious) delivering 200 random bytes instead of the bundle");
  await tx("seller", `deliver #${id} (garbage)`, () => evalBounty(ctx.seller).write.deliver([id, bytesToHex(garbage)]));
  const v = await buyerVerify(ctx.buyer, id, ctx.provider);
  expect(v.verdict.action === "dispute" && v.verdict.kind === DisputeKind.BadDelivery, "expected BadDelivery dispute");
  const b = await evalBounty().read.getBounty([id]);
  const decision = await arbitrate(id, ctx.provider, ctx.arbiterKp);
  expect(decision.ruling === 2n, "arbiter should rule for the buyer");
  await arbiterRule(ctx.arbiter, b.disputeId, decision);
  await expectStatus(id, Status.Refunded);
  await withdrawIfAny(ctx.buyer, "buyer");
  return id;
}

export const STORIES = { happy: storyHappy, junk: storyJunk, easy: storyEasy, bad: storyBadDelivery } as const;
export type StoryName = keyof typeof STORIES;

export async function reputationSummary(ctx: Ctx) {
  const c = evalBounty();
  for (const [name, w] of [["seller", ctx.seller], ["junk", ctx.junk]] as const) {
    const r = await c.read.sellerRep([w.account.address]);
    log("story", `${name} ${short(w.account.address)} rep: commits=${r[0]} rejected=${r[1]} abandoned=${r[2]} delivered=${r[3]} timeouts=${r[4]} settled=${r[5]} won=${r[6]} lost=${r[7]} volume=${eth(r[8])}`);
  }
  const b = await c.read.buyerRep([ctx.buyer.account.address]);
  log("story", `buyer ${short(ctx.buyer.account.address)} rep: created=${b[0]} settled=${b[1]} disputes=${b[2]} lost=${b[3]}`);
}

export type { Hex };
