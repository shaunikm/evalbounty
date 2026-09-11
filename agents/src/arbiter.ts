/**
 * Arbiter agent: owner of the CentralizedArbitrator (ERC-792).
 *
 *   on Disputed:
 *     BadDelivery  -> evidence is the buyer's X25519 secret. Open the sealed box, decrypt, check
 *                     commitment + Merkle root. Rule for the buyer iff the delivery really is bad.
 *     ClaimsFailed -> evidence is (bundle key sealed to us, buyer's transcript hash). Decrypt
 *                     privately, rerun the three claims with the pinned run params, rule for the
 *                     seller iff the claims hold. Post our transcript hash as ruling evidence.
 *   also: finalize() anything past its deadline so the demo never stalls.
 */
import { bytesToHex, decodeAbiParameters, keccak256, type Hex } from "viem";
import { parseBundle, runParamsHash } from "./lib/bundle.js";
import { DisputeKind, Ruling, Status, StatusName, arbitrator, env, evalBounty, log, publicClient, short, sleep, tx, wallet, type Wallet } from "./lib/chain.js";
import { decryptBundle, decryptWithKey, openSealedKey, publicKeyFromSecret, type KeyPairHex } from "./lib/crypto.js";
import { deliveredCiphertext, disputedEvents, latestDispute } from "./lib/events.js";
import { buildTaskTree } from "./lib/merkle.js";
import { getProvider, type ModelProvider } from "./lib/models.js";
import { legacyArbiterKeys, loadOrCreateArbiterKeys } from "./deploy.js";
import { claimsHold, fmt, measureBundle, transcriptHash, ttyProgress } from "./lib/verify.js";
import { toClaimSpec, withdrawIfAny } from "./seller.js";

export interface Decision {
  ruling: bigint;
  evidence: string;
}

export async function arbitrate(id: bigint, provider: ModelProvider, arbiterKp: KeyPairHex, who = "arbiter"): Promise<Decision> {
  const c = evalBounty();
  const b = await c.read.getBounty([id]);
  const d = await latestDispute(id);
  const { ciphertext } = await deliveredCiphertext(id);
  const forBuyer = (why: string, extra: Record<string, unknown> = {}): Decision => {
    log(who, `ruling for the BUYER: ${why}`);
    return { ruling: Ruling.Buyer, evidence: JSON.stringify({ ruling: "buyer", why, ...extra }) };
  };
  const forSeller = (why: string, extra: Record<string, unknown> = {}): Decision => {
    log(who, `ruling for the SELLER: ${why}`);
    return { ruling: Ruling.Seller, evidence: JSON.stringify({ ruling: "seller", why, ...extra }) };
  };

  if (d.kind === DisputeKind.BadDelivery) {
    log(who, `#${id} BadDelivery dispute: buyer published its X25519 secret; anyone can redo this check`);
    // The evidence must be THE buyer's key: a wrong secret would make any good ciphertext "fail to open".
    let derived: Hex;
    try {
      derived = await publicKeyFromSecret(d.evidence);
    } catch (e) {
      return forSeller(`evidence is not a valid X25519 secret key (${(e as Error).message})`);
    }
    if (derived.toLowerCase() !== b.buyerPubKey.toLowerCase()) {
      return forSeller(`published secret derives ${short(derived)}, not the bounty's buyer key ${short(b.buyerPubKey)}; evidence is not bound to this bounty`);
    }
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await decryptBundle(ciphertext, { publicKey: b.buyerPubKey, secretKey: d.evidence }));
    } catch (e) {
      return forBuyer(`ciphertext does not open with the buyer's key (${(e as Error).message})`);
    }
    const commitment = keccak256(plaintext);
    if (commitment !== b.bundleCommitment) return forBuyer(`plaintext hash ${short(commitment)} != commitment ${short(b.bundleCommitment)}`);
    try {
      const bundle = parseBundle(plaintext);
      const root = buildTaskTree(bundle.tasks).root as Hex;
      if (root !== b.taskRoot) return forBuyer(`Merkle root ${short(root)} != committed ${short(b.taskRoot)}`);
      if (bundle.tasks.length !== b.spec.taskCount) return forBuyer("task count mismatch");
    } catch (e) {
      return forBuyer(`bundle malformed: ${(e as Error).message}`);
    }
    return forSeller("delivery decrypts to exactly the committed bundle; the buyer's BadDelivery claim is false");
  }

  // ClaimsFailed
  log(who, `#${id} ClaimsFailed dispute: opening the bundle key sealed to me (bundle stays private)`);
  const [sealedHex, buyerTranscriptHash] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes32" }], d.evidence);
  let key: Uint8Array;
  try {
    key = await openSealedKey(Buffer.from(sealedHex.slice(2), "hex"), arbiterKp);
  } catch (e) {
    const legacy = legacyArbiterKeys();
    try {
      if (!legacy) throw e;
      key = await openSealedKey(Buffer.from(sealedHex.slice(2), "hex"), legacy);
    } catch {
      return forSeller(`buyer's evidence does not open for the arbiter (${(e as Error).message}); cannot substantiate the dispute`);
    }
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptWithKey(ciphertext, key);
  } catch (e) {
    return forSeller(`ciphertext does not decrypt with the key the buyer provided (${(e as Error).message})`);
  }
  const commitment = keccak256(plaintext);
  if (commitment !== b.bundleCommitment) return forBuyer(`plaintext hash != commitment (delivery is bad regardless of the dispute kind)`);
  const bundle = parseBundle(plaintext);
  if ((buildTaskTree(bundle.tasks).root as Hex) !== b.taskRoot) return forBuyer("Merkle root mismatch");
  if (runParamsHash(bundle.runParams) !== b.spec.runParamsHash) return forBuyer("run params differ from the pinned hash");
  const claim = toClaimSpec(b.spec);
  log(who, `re-running ${claim.weakModel} / ${claim.strongModel} x ${claim.runs} on ${bundle.tasks.length} tasks with the committed run params…`);
  const t = await measureBundle(bundle, claim, provider, commitment, { onProgress: ttyProgress(who) });
  const s = t.scores;
  const v = claimsHold(s, claim);
  const th = transcriptHash(t);
  log(who, `arbiter measured weak ${fmt(s.weak)} strong ${fmt(s.strong)} null ${fmt(s.null)}; transcript ${short(th)} (buyer's: ${short(buyerTranscriptHash)}${th === buyerTranscriptHash ? ", identical" : ""})`);
  const extra = { transcriptHash: th, buyerTranscriptHash, scores: s, band: { weakMax: claim.weakMaxBps, strongMin: claim.strongMinBps, nullMax: claim.nullMaxBps, tol: claim.toleranceBps } };
  return v.ok ? forSeller("claims reproduce within tolerance", extra) : forBuyer(v.reasons.join("; "), extra);
}

/** Publish the derived X25519 key on the arbitrator contract if it differs (owner-only, idempotent). */
export async function ensureArbiterPubKey(w: Wallet, kp: KeyPairHex, who = "arbiter") {
  const a = arbitrator(w);
  const onchain = (await a.read.arbiterPubKey()) as Hex;
  if (onchain.toLowerCase() === kp.publicKey.toLowerCase()) return false;
  log(who, `on-chain arbiter key ${short(onchain)} differs from my derived key ${short(kp.publicKey)}; updating`);
  await tx(who, "setArbiterPubKey", () => a.write.setArbiterPubKey([kp.publicKey as Hex]));
  return true;
}

export async function arbiterRule(w: Wallet, disputeId: bigint, decision: Decision, who = "arbiter") {
  const a = arbitrator(w);
  return tx(who, `giveRuling(dispute ${disputeId}, ${decision.ruling === Ruling.Seller ? "seller" : decision.ruling === Ruling.Buyer ? "buyer" : "refused"})`, () =>
    a.write.giveRuling([disputeId, decision.ruling, decision.evidence]),
  );
}

/** Push any bounty past a deadline. Returns the ids finalized. */
export async function finalizeStale(w: Wallet, who = "arbiter"): Promise<bigint[]> {
  const c = evalBounty(w);
  const now = BigInt((await publicClient().getBlock()).timestamp);
  const blockNumber = await publicClient().getBlockNumber({ cacheTime: 0 });
  const done: bigint[] = [];
  const count = await c.read.bountyCount();
  for (let id = 0n; id < count; id++) {
    const b = await c.read.getBounty([id]);
    const stale =
      (b.status === Status.Committed && blockNumber > b.sampleBlock + 256n) ||
      (b.status === Status.Sampled && now > BigInt(b.approveBy)) ||
      (b.status === Status.Approved && now > BigInt(b.deliverBy)) ||
      (b.status === Status.Delivered && now > BigInt(b.verifyBy)) ||
      (b.status === Status.Disputed && now > BigInt(b.ruleBy));
    if (!stale) continue;
    log(who, `#${id} is ${StatusName[b.status]} past its deadline -> finalize`);
    try {
      await tx(who, `finalize #${id}`, () => c.write.finalize([id]));
      done.push(id);
    } catch (e) {
      log(who, `finalize #${id} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return done;
}

export async function runArbiter(opts: { who?: string; once?: boolean } = {}) {
  const who = opts.who ?? "arbiter";
  const w = wallet(env.key("ARBITER_KEY"));
  const provider = await getProvider();
  const kp = await loadOrCreateArbiterKeys();
  const c = evalBounty(w);
  log(who, `online as ${w.account.address}; X25519 ${short(kp.publicKey)} derived from my wallet (${provider.name} provider)`);
  await ensureArbiterPubKey(w, kp, who);
  for (;;) {
    try {
      const evs = await disputedEvents();
      for (const ev of evs) {
        const id = ev.args.id;
        const b = await c.read.getBounty([id]);
        if (b.status !== Status.Disputed) continue;
        const decision = await arbitrate(id, provider, kp, who);
        await arbiterRule(w, b.disputeId, decision, who);
      }
      await finalizeStale(w, who);
      await withdrawIfAny(w, who);
    } catch (e) {
      log(who, `error: ${(e as Error).message}`);
    }
    if (opts.once) return;
    await sleep(env.chainName === "anvil" ? 1500 : 8000);
  }
}

if (process.argv[1] && /arbiter\.ts$/.test(process.argv[1])) {
  runArbiter({ once: process.argv.includes("--once") }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { bytesToHex };
