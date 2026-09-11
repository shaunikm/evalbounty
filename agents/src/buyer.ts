/**
 * Buyer agent.
 *
 *   create bounty (fresh X25519 keypair per bounty) -> on SampleRevealed: objective checks +
 *   strong-model spot check -> approve / reject -> on Delivered: decrypt, verify commitment and
 *   Merkle root, rerun the three claims -> accept / dispute.
 *
 * Every decision is one plain-English log line (the video narrates itself).
 */
import { bytesToHex, decodeEventLog, encodeAbiParameters, hexToBytes, keccak256, parseEther, parseEventLogs, type Hex } from "viem";
import { evalBountyAbi } from "./lib/abi.js";
import { grade, objectiveTaskChecks, parseBundle, runParamsHash, DEFAULT_RUN_PARAMS, type Task } from "./lib/bundle.js";
import { DisputeKind, Status, StatusName, arbitrator, env, eth, evalBounty, log, short, sleep, tx, wallet, type Wallet } from "./lib/chain.js";
import { decryptBundle, generateKeyPair, publicKeyFromSecret, sealKeyTo, type KeyPairHex } from "./lib/crypto.js";
import { deliveredCiphertext, revealedTasks, type Revealed } from "./lib/events.js";
import { buildTaskTree } from "./lib/merkle.js";
import { defaultModels, getProvider, providerName, type ModelProvider } from "./lib/models.js";
import { loadState, saveState } from "./lib/state.js";
import { claimsHold, fmt, measureBundle, transcriptHash, type Transcript } from "./lib/verify.js";
import { toClaimSpec, withdrawIfAny } from "./seller.js";

export interface BuyerConfig {
  domainTag: string;
  taskCount: number;
  sampleSize: number;
  weakModel: string;
  strongModel: string;
  weakMaxBps: number;
  strongMinBps: number;
  nullMaxBps: number;
  runs: number;
  toleranceBps: number;
  rewardWei: bigint;
}

export function defaultBuyerConfig(provider = providerName()): BuyerConfig {
  const m = defaultModels(provider);
  return {
    domainTag: "exact-answer-reasoning",
    taskCount: 30,
    sampleSize: 4,
    weakModel: m.weak,
    strongModel: m.strong,
    weakMaxBps: 3500,
    strongMinBps: 6500,
    nullMaxBps: 500,
    runs: provider === "mock" ? 2 : 3,
    toleranceBps: 1000,
    rewardWei: parseEther("0.002"),
  };
}

export interface BountyState {
  kp: KeyPairHex;
  createdTx: Hex;
}

export async function createBounty(w: Wallet, cfg: BuyerConfig, who = "buyer"): Promise<bigint> {
  const c = evalBounty(w);
  const kp = await generateKeyPair();
  const spec = {
    domainTag: cfg.domainTag,
    taskCount: cfg.taskCount,
    sampleSize: cfg.sampleSize,
    weakModel: cfg.weakModel,
    strongModel: cfg.strongModel,
    weakMaxBps: cfg.weakMaxBps,
    strongMinBps: cfg.strongMinBps,
    nullMaxBps: cfg.nullMaxBps,
    runs: cfg.runs,
    toleranceBps: cfg.toleranceBps,
    runParamsHash: runParamsHash(DEFAULT_RUN_PARAMS),
  };
  log(who, `posting bounty: ${cfg.taskCount} ${cfg.domainTag} tasks, reveal ${cfg.sampleSize}, band weak(${cfg.weakModel})<=${fmt(cfg.weakMaxBps)} strong(${cfg.strongModel})>=${fmt(cfg.strongMinBps)} null<=${fmt(cfg.nullMaxBps)}, ±${fmt(cfg.toleranceBps)}, reward ${eth(cfg.rewardWei)}`);
  const r = await tx(who, "createBounty", () => c.write.createBounty([spec, kp.publicKey as Hex], { value: cfg.rewardWei }));
  const logs = parseEventLogs({ abi: evalBountyAbi, logs: r.logs, eventName: "BountyCreated" });
  const id = logs[0]!.args.id;
  saveState(`buyer-bounty-${id}`, { kp, createdTx: r.transactionHash } satisfies BountyState);
  log(who, `bounty #${id} is Open; my delivery key is ${short(kp.publicKey)} (secret stays local)`);
  return id;
}

export interface SampleVerdict {
  approve: boolean;
  notes: string[];
}

/** Objective checks + a strong-model spot check on the revealed tasks. No LLM judge needed. */
export async function judgeSample(revealed: Revealed[], spec: { domainTag: string; strongModel: string; sampleSize: number }, expectedIdx: number[], provider: ModelProvider, runParams = DEFAULT_RUN_PARAMS): Promise<SampleVerdict> {
  const notes: string[] = [];
  if (revealed.length !== expectedIdx.length) notes.push(`expected ${expectedIdx.length} revealed tasks, got ${revealed.length}`);
  const prompts = new Set<string>();
  for (const r of revealed) {
    const problems = objectiveTaskChecks(r.task, r.index, spec.domainTag);
    for (const p of problems) notes.push(`task ${r.index}: ${p}`);
    if (prompts.has(r.task.prompt)) notes.push(`task ${r.index}: duplicate prompt`);
    prompts.add(r.task.prompt);
  }
  // Spot check: the strong model should be able to solve at least one sampled task. Unanswerable
  // or garbage prompts score zero for every model, including the one the seller claims gets 65%+.
  let solved = 0;
  for (const r of revealed) {
    const answer = await provider.complete(spec.strongModel, r.task.prompt, runParams, { task: r.task, run: 0 });
    solved += grade(r.task, answer);
  }
  notes.push(`strong model solved ${solved}/${revealed.length} of the revealed tasks`);
  if (revealed.length > 0 && solved === 0) notes.push("strong model solved none of the sample: tasks look unanswerable or mis-keyed");
  const hardProblems = notes.filter((n) => !n.startsWith("strong model solved "));
  return { approve: hardProblems.length === 0, notes };
}

export async function buyerJudge(w: Wallet, id: bigint, provider: ModelProvider, who = "buyer") {
  const c = evalBounty(w);
  const b = await c.read.getBounty([id]);
  const revealed = await revealedTasks(id);
  const expected = (await c.read.sampleIndices([id])).map(Number);
  for (const r of revealed) log(who, `revealed task ${r.index} [${r.task.family}${r.task.sourceId ? ` · ${r.task.sourceId}` : `/d${r.task.difficulty}`}]: "${r.task.prompt.replace(/\s+/g, " ").slice(0, 90)}${r.task.prompt.length > 90 ? "…" : ""}" -> ${r.task.reference}`);
  const v = await judgeSample(revealed, b.spec, expected, provider);
  for (const n of v.notes) log(who, `  · ${n}`);
  if (v.approve) {
    log(who, `sample looks well-posed and in-domain -> approving #${id}`);
    return { verdict: v, receipt: await tx(who, `approveSample #${id}`, () => c.write.approveSample([id])) };
  }
  const reason = v.notes.filter((n) => !n.startsWith("strong model solved ")).join("; ").slice(0, 200);
  log(who, `rejecting sample of #${id}: ${reason}`);
  return { verdict: v, receipt: await tx(who, `rejectSample #${id}`, () => c.write.rejectSample([id, reason])) };
}

export type DeliveryVerdict =
  | { action: "accept"; transcript: Transcript }
  | { action: "dispute"; kind: number; evidence: Hex; reasons: string[]; transcript?: Transcript };

export async function verifyDelivery(id: bigint, ciphertext: Uint8Array, kp: KeyPairHex, provider: ModelProvider, who = "buyer"): Promise<DeliveryVerdict> {
  const c = evalBounty();
  const b = await c.read.getBounty([id]);
  const badDelivery = (why: string): DeliveryVerdict => {
    log(who, `BAD DELIVERY: ${why}. Disputing with my X25519 secret as public evidence so anyone can reproduce the check.`);
    return { action: "dispute", kind: DisputeKind.BadDelivery, evidence: kp.secretKey as Hex, reasons: [why] };
  };
  // Guard against local state mix-ups: a dispute with the wrong key would be lost, not won.
  const derived = await publicKeyFromSecret(kp.secretKey as Hex);
  if (derived.toLowerCase() !== b.buyerPubKey.toLowerCase()) {
    throw new Error(`local key for bounty #${id} derives ${short(derived)} but the bounty was created with ${short(b.buyerPubKey)}; refusing to dispute with mismatched evidence`);
  }
  let plaintext: Uint8Array;
  let key: Uint8Array;
  try {
    ({ plaintext, key } = await decryptBundle(ciphertext, kp));
  } catch (e) {
    return badDelivery(`ciphertext does not open with my key (${(e as Error).message})`);
  }
  const commitment = keccak256(plaintext);
  if (commitment !== b.bundleCommitment) return badDelivery(`keccak(plaintext) ${short(commitment)} != committed ${short(b.bundleCommitment)}`);
  log(who, `decrypted ${plaintext.length} bytes; keccak matches the commitment ${short(commitment)}`);
  let bundle;
  try {
    bundle = parseBundle(plaintext);
  } catch (e) {
    return badDelivery(`bundle does not parse: ${(e as Error).message}`);
  }
  if (bundle.tasks.length !== b.spec.taskCount) return badDelivery(`bundle has ${bundle.tasks.length} tasks, spec says ${b.spec.taskCount}`);
  const root = buildTaskTree(bundle.tasks).root as Hex;
  if (root !== b.taskRoot) return badDelivery(`rebuilt Merkle root ${short(root)} != committed ${short(b.taskRoot)}`);
  if (runParamsHash(bundle.runParams) !== b.spec.runParamsHash) return badDelivery("bundle run params differ from the pinned runParamsHash");
  log(who, `Merkle root over all ${bundle.tasks.length} tasks matches ${short(root)}: the revealed sample was drawn from exactly this bundle`);
  const badRefs = bundle.tasks.filter((t: Task) => grade(t, t.reference) !== 1).length;
  if (badRefs > 0) log(who, `warning: ${badRefs} reference answers fail their own grader`);

  const claim = toClaimSpec(b.spec);
  log(who, `re-running claims: ${claim.weakModel} and ${claim.strongModel}, ${claim.runs} run(s) x ${bundle.tasks.length} tasks…`);
  const transcript = await measureBundle(bundle, claim, provider, commitment);
  const s = transcript.scores;
  log(who, `measured weak ${fmt(s.weak)} strong ${fmt(s.strong)} null ${fmt(s.null)} (seller advertised weak ${fmt(bundle.sellerMeasured.weak)} strong ${fmt(bundle.sellerMeasured.strong)}); SE weak ±${fmt(transcript.standardErrorBps.weak)}`);
  const v = claimsHold(s, claim);
  if (v.ok) {
    log(who, `all three claims hold within ±${fmt(claim.toleranceBps)} -> accepting`);
    return { action: "accept", transcript };
  }
  for (const r of v.reasons) log(who, `  ✗ ${r}`);
  const arbPub = (await arbitrator().read.arbiterPubKey()) as Hex;
  const sealed = await sealKeyTo(key, arbPub);
  const evidence = encodeAbiParameters([{ type: "bytes" }, { type: "bytes32" }], [bytesToHex(sealed), transcriptHash(transcript)]);
  log(who, `CLAIMS FAILED -> disputing; bundle key sealed to arbiter ${short(arbPub)} (bundle stays private), my transcript hash ${short(transcriptHash(transcript))}`);
  return { action: "dispute", kind: DisputeKind.ClaimsFailed, evidence, reasons: v.reasons, transcript };
}

export async function buyerVerify(w: Wallet, id: bigint, provider: ModelProvider, who = "buyer") {
  const c = evalBounty(w);
  const st = loadState<BountyState>(`buyer-bounty-${id}`);
  if (!st) throw new Error(`no local key for bounty #${id}`);
  const { ciphertext, txHash } = await deliveredCiphertext(id);
  log(who, `fetched ${ciphertext.length}-byte ciphertext from the Delivered event (tx ${short(txHash)})`);
  const verdict = await verifyDelivery(id, ciphertext, st.kp, provider, who);
  saveState(`buyer-verdict-${id}`, verdict);
  if (verdict.action === "accept") {
    return { verdict, receipt: await tx(who, `accept #${id}`, () => c.write.accept([id])) };
  }
  const cost = await c.read.disputeCost([id]);
  log(who, `posting dispute bond + arbitration fee ${eth(cost)}`);
  return { verdict, receipt: await tx(who, `dispute #${id} (${verdict.kind === DisputeKind.BadDelivery ? "BadDelivery" : "ClaimsFailed"})`, () => c.write.dispute([id, verdict.kind, verdict.evidence], { value: cost })) };
}

// ------------------------------------------------------------------ long-running loop

export async function runBuyer(cfg = defaultBuyerConfig(), opts: { maxBounties?: number; who?: string; once?: boolean; exitWhenDone?: boolean } = {}) {
  const who = opts.who ?? "buyer";
  const w = wallet(env.key("BUYER_KEY"));
  const provider = await getProvider();
  const c = evalBounty(w);
  const max = opts.maxBounties ?? 1;
  log(who, `online as ${w.account.address} (${provider.name} provider)`);
  const mine: bigint[] = [];
  const lastStatus = new Map<string, number>();
  const count = await c.read.bountyCount();
  for (let i = 0n; i < count; i++) {
    const b = await c.read.getBounty([i]);
    if (b.buyer.toLowerCase() === w.account.address.toLowerCase() && loadState(`buyer-bounty-${i}`)) mine.push(i);
  }
  for (;;) {
    try {
      const live = [] as bigint[];
      for (const id of mine) {
        const b = await c.read.getBounty([id]);
        if (b.status === Status.Sampled) await buyerJudge(w, id, provider, who);
        else if (b.status === Status.Delivered) await buyerVerify(w, id, provider, who);
        if (![Status.Settled, Status.Refunded, Status.Cancelled].includes(b.status as 6 | 7 | 8)) live.push(id);
        const now = (await c.read.getBounty([id])).status;
        if (lastStatus.get(id.toString()) !== now) {
          lastStatus.set(id.toString(), now);
          log(who, `#${id} is ${StatusName[now]}`);
        }
      }
      let created = false;
      if (live.length === 0 && mine.length < max) {
        mine.push(await createBounty(w, cfg, who));
        created = true;
      }
      await withdrawIfAny(w, who);
      if (opts.exitWhenDone && !created && live.length === 0 && mine.length >= max) {
        log(who, `all ${max} bounties reached a terminal state; exiting`);
        return;
      }
    } catch (e) {
      log(who, `error: ${(e as Error).message}`);
    }
    if (opts.once) return;
    await sleep(env.chainName === "sepolia" ? 8000 : 1500);
  }
}

if (process.argv[1] && /buyer\.ts$/.test(process.argv[1])) {
  const n = Number(process.argv.find((a) => a.startsWith("--bounties="))?.split("=")[1] ?? 1);
  runBuyer(defaultBuyerConfig(), { maxBounties: n, exitWhenDone: process.argv.includes("--exit-when-done") }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { decodeEventLog, hexToBytes };
