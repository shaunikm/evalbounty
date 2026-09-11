/**
 * The four scripted stories, driven step by step (no polling races). Used by e2e-anvil.ts as a
 * regression test and by demo.ts on Sepolia for the video.
 *
 *   happy   honest seller -> sample approved -> claims reproduce -> Settled
 *   junk    junk seller   -> sample rejected -> bounty reopens -> honest seller completes it
 *   easy    dishonest seller ships easy tasks but claims the band -> ClaimsFailed dispute -> arbitrator rules for buyer
 *   bad     seller delivers garbage ciphertext -> BadDelivery dispute -> arbitrator rules for buyer
 *   committee  the easy story again with the market switched to the sortitioned staked committee
 *
 * Disputes settle through whichever ERC-792 arbitrator the bounty is pinned to: the single-key
 * arbiter (arbitrate + giveRuling) or the committee (sortition, key handoff, commit-reveal, tally).
 */
import { bytesToHex, type Address, type Hex } from "viem";
import { arbitrate, arbiterRule, ensureArbiterPubKey } from "./arbiter.js";
import { buyerHandoffKeys, buyerJudge, buyerVerify, createBounty, type BuyerConfig } from "./buyer.js";
import { switchArbitrator } from "./deploy.js";
import { commitVote, decideVote, drawIfNeeded, ensureStaked, executeIfReady, revealVote, richest } from "./juror.js";
import { DisputeKind, Status, StatusName, arbitratorKind, committee, eth, evalBounty, log, short, tx, waitForBlockAfter, type Wallet } from "./lib/chain.js";
import type { KeyPairHex } from "./lib/crypto.js";
import type { ModelProvider } from "./lib/models.js";
import { prepareBundle, sellerCommit, sellerDeliver, sellerReveal, sellerSalt, withdrawIfAny } from "./seller.js";

export interface Ctx {
  provider: ModelProvider;
  buyer: Wallet;
  seller: Wallet;
  junk: Wallet;
  arbiter: Wallet;
  arbiterKp: KeyPairHex;
  cfg: BuyerConfig;
  /** Sortitioned committee (optional): its address and the juror wallets this demo controls. */
  committee?: Address;
  jurors?: Wallet[];
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
  const prep = await prepareBundle((await evalBounty().read.getBounty([id])).spec, ctx.provider, { seed: `seller-${ctx.seller.account.address}-${id}`, saltFor: sellerSalt(ctx.seller, id) });
  await sellerCommit(ctx.seller, id, prep);
  await sellerReveal(ctx.seller, id, prep);
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(j.verdict.approve, "buyer should approve an honest sample");
  await sellerDeliver(ctx.seller, id, prep);
  const v = await buyerVerify(ctx.buyer, id, ctx.provider);
  expect(v.verdict.action === "accept", `buyer should accept an honest delivery, got ${JSON.stringify(v.verdict)}`);
  await expectStatus(id, Status.Settled);
}

/**
 * Full committee round for a Disputed bounty: wait for the sortition block, draw the panel, hand the
 * bundle key to the drawn jurors (ClaimsFailed only; BadDelivery evidence is public), each seated
 * juror reruns and commits a hidden vote, reveals, then anyone tallies. Permissionless calls go
 * through the best-funded juror wallet. Returns the seated juror wallets.
 */
async function settleViaCommittee(ctx: Ctx, id: bigint, committeeAddr: Address): Promise<Wallet[]> {
  const jurors = ctx.jurors ?? [];
  expect(jurors.length > 0, `bounty #${id} is arbitrated by committee ${committeeAddr}; set JUROR_KEYS so the demo can seat the panel (or switch the market back)`);
  const cm = committee(committeeAddr);
  const b = await evalBounty().read.getBounty([id]);
  const payer = await richest(jurors);
  let panel: Address[] = [];
  for (let attempt = 0; attempt < 3 && panel.length === 0; attempt++) {
    const d = await cm.read.getDispute([b.disputeId]);
    await waitForBlockAfter(d[4], "juror"); // sortition block (moves forward if the hash expired and the panel re-rolled)
    panel = await drawIfNeeded(payer, committeeAddr, b.disputeId, "juror");
  }
  expect(panel.length === Number(await cm.read.panelSize()), "panel drawn");
  if (b.disputeKind === DisputeKind.ClaimsFailed) expect(await buyerHandoffKeys(ctx.buyer, id), "buyer sealed the bundle key to the panel");
  else log("story", "BadDelivery: the evidence is public, jurors need no key handoff");
  const onPanel = jurors.filter((w) => panel.map((a) => a.toLowerCase()).includes(w.account.address.toLowerCase()));
  expect(onPanel.length === panel.length, `demo controls every drawn juror (${onPanel.length}/${panel.length})`);
  for (const w of onPanel) {
    const decision = await decideVote(w, committeeAddr, b.disputeId, ctx.provider, "juror");
    expect(decision !== undefined, "juror could evaluate");
    log("juror", `${short(w.account.address)} votes ${["refuse", "seller", "buyer"][decision!.vote]}: ${decision!.why.slice(0, 100)}`);
    await commitVote(w, committeeAddr, b.disputeId, decision!.vote, "juror");
  }
  for (const w of onPanel) await revealVote(w, committeeAddr, b.disputeId, "juror");
  expect(await executeIfReady(payer, committeeAddr, b.disputeId, "juror"), "tally executed");
  return onPanel;
}

/** Settle a Disputed bounty through whichever ERC-792 arbitrator it is pinned to. */
async function settleDispute(ctx: Ctx, id: bigint) {
  const b = await evalBounty().read.getBounty([id]);
  if ((await arbitratorKind(b.arbitrator)) === "committee") {
    await settleViaCommittee(ctx, id, b.arbitrator);
  } else {
    const decision = await arbitrate(id, ctx.provider, ctx.arbiterKp);
    await arbiterRule(ctx.arbiter, b.disputeId, decision);
  }
}

/** Call once before any story: makes the on-chain arbiter key match the derived one. */
export async function prepareArbiter(ctx: Ctx) {
  await ensureArbiterPubKey(ctx.arbiter, ctx.arbiterKp);
}

export async function storyHappy(ctx: Ctx) {
  log("story", "━━ 1/5 happy path: honest seller, honest buyer");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  await honestFulfil(ctx, id);
  const c = evalBounty();
  const owedSeller = await c.read.pending([ctx.seller.account.address]);
  log("story", `seller can withdraw ${eth(owedSeller)} (reward − 2% fee + bond)`);
  await withdrawIfAny(ctx.seller, "seller");
  return id;
}

export async function storyJunk(ctx: Ctx) {
  log("story", "━━ 2/5 junk seller: unanswerable prompts, caught by the random sample");
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
  log("story", "━━ 3/5 dishonest seller: well-posed but too-easy tasks, claims the band anyway");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  const spec = (await evalBounty().read.getBounty([id])).spec;
  const prep = await prepareBundle(spec, ctx.provider, { seed: `easy-${id}`, forceDifficulty: 1, who: "seller", saltFor: sellerSalt(ctx.seller, id) });
  await sellerCommit(ctx.seller, id, prep);
  await sellerReveal(ctx.seller, id, prep);
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(j.verdict.approve, "sample of easy-but-valid tasks passes the objective checks (difficulty is not visible from 4 tasks)");
  await sellerDeliver(ctx.seller, id, prep);
  const v = await buyerVerify(ctx.buyer, id, ctx.provider);
  expect(v.verdict.action === "dispute" && v.verdict.kind === DisputeKind.ClaimsFailed, `expected ClaimsFailed dispute, got ${JSON.stringify(v.verdict.action)}`);
  await expectStatus(id, Status.Disputed);
  const b = await evalBounty().read.getBounty([id]);
  await settleDispute(ctx, id);
  await expectStatus(id, Status.Refunded);
  const owed = await evalBounty().read.pending([ctx.buyer.account.address]);
  expect(owed >= b.reward + b.disputeBond + b.sellerBond, "buyer gets reward + own bond + seller bond");
  log("story", `buyer recovers ${eth(owed)}: reward + dispute bond + the seller's slashed bond`);
  await withdrawIfAny(ctx.buyer, "buyer");
  return id;
}

export async function storyBadDelivery(ctx: Ctx) {
  log("story", "━━ 4/5 bad delivery: seller posts garbage ciphertext after an approved sample");
  const id = await createBounty(ctx.buyer, ctx.cfg);
  const spec = (await evalBounty().read.getBounty([id])).spec;
  const prep = await prepareBundle(spec, ctx.provider, { seed: `bad-${id}`, saltFor: sellerSalt(ctx.seller, id) });
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
  await expectStatus(id, Status.Disputed);
  await settleDispute(ctx, id);
  await expectStatus(id, Status.Refunded);
  await withdrawIfAny(ctx.buyer, "buyer");
  return id;
}

/**
 * Story 5: the same dishonest seller, but the market's arbitrator is a sortitioned, staked committee.
 * The panel is drawn by the chain after the dispute exists; the buyer seals the bundle key to the
 * drawn jurors; each juror reruns at higher precision, commits a hidden vote, reveals; the tally
 * needs a two-thirds supermajority, coherent jurors share the fee, and the ruling reaches EvalBounty
 * through the same ERC-792 callback as before. Leaves the market on the committee afterwards.
 */
export async function storyCommittee(ctx: Ctx) {
  if (!ctx.committee || !ctx.jurors?.length) {
    log("story", "━━ 5/5 committee: skipped (no COMMITTEE_ADDRESS / JUROR_KEYS)");
    return -1n;
  }
  log("story", "━━ 5/5 sortitioned committee: nobody picks the judges, judges have stake at risk");
  const cm = committee(ctx.committee);
  const minStake = await cm.read.minStake();
  for (const j of ctx.jurors) await ensureStaked(j, ctx.committee, minStake, "juror");
  log("story", `${await cm.read.eligibleJurors()} eligible jurors, panel of ${await cm.read.panelSize()}, each staking ≥ ${eth(minStake)}; secured value ${eth(await cm.read.securedValue())}`);
  if (await switchArbitrator(ctx.committee)) log("story", "market owner switched the ERC-792 arbitrator to the committee (one call, EvalBounty untouched)");

  const id = await createBounty(ctx.buyer, ctx.cfg);
  const spec = (await evalBounty().read.getBounty([id])).spec;
  const { prepareBundle, sellerCommit, sellerDeliver, sellerReveal, sellerSalt } = await import("./seller.js");
  const prep = await prepareBundle(spec, ctx.provider, { seed: `committee-${id}`, forceDifficulty: 1, who: "seller", saltFor: sellerSalt(ctx.seller, id) });
  await sellerCommit(ctx.seller, id, prep);
  await sellerReveal(ctx.seller, id, prep);
  const j = await buyerJudge(ctx.buyer, id, ctx.provider);
  expect(j.verdict.approve, "sample of easy-but-valid tasks passes");
  await sellerDeliver(ctx.seller, id, prep);
  const v = await buyerVerify(ctx.buyer, id, ctx.provider);
  expect(v.verdict.action === "dispute" && v.verdict.kind === DisputeKind.ClaimsFailed, "expected ClaimsFailed dispute");
  await expectStatus(id, Status.Disputed);

  const stakesBefore = new Map<string, bigint>();
  const pendingBefore = new Map<string, bigint>();
  for (const w of ctx.jurors) {
    stakesBefore.set(w.account.address, (await cm.read.jurorInfo([w.account.address]))[0]);
    pendingBefore.set(w.account.address, await cm.read.pending([w.account.address]));
  }
  const onPanel = await settleViaCommittee(ctx, id, ctx.committee);
  await expectStatus(id, Status.Refunded);
  const fee = await cm.read.jurorFee();
  for (const w of onPanel) {
    const stake = (await cm.read.jurorInfo([w.account.address]))[0];
    expect(stake === stakesBefore.get(w.account.address), "coherent juror keeps full stake");
    expect((await cm.read.pending([w.account.address])) - pendingBefore.get(w.account.address)! === fee, "coherent juror earns its fee share");
  }
  log("story", `unanimous panel: nobody slashed, each juror earned ${eth(fee)}; the dishonest seller's bond went to the buyer`);
  await withdrawIfAny(ctx.buyer, "buyer");
  return id;
}

export const STORIES = { happy: storyHappy, junk: storyJunk, easy: storyEasy, bad: storyBadDelivery, committee: storyCommittee } as const;
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
