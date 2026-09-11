/**
 * Seller agent.
 *
 *   on BountyCreated (Open, in-domain) -> generate N tasks, measure the band with the pinned run
 *   params, tune difficulty until the claims sit inside the band -> commit(root, commitment, bond)
 *   -> wait one block -> revealSample(tasks, proofs) -> on SampleApproved: encrypt to the buyer's
 *   key and deliver -> on Settled: withdraw.
 *
 *   --junk     ship unanswerable prompts (shows the sample check catching it)
 *   --easy     ship difficulty-1 tasks but claim the band anyway (shows the claims dispute path)
 *
 * The exported step functions are what stories.ts / e2e-anvil.ts drive deterministically.
 */
import { bytesToHex, type Address, type Hex } from "viem";
import { bundleBytes, bundleCommitment, DEFAULT_RUN_PARAMS, runParamsHash, taskBytes, type Bundle } from "./lib/bundle.js";
import { Status, StatusName, env, eth, evalBounty, log, publicClient, short, sleep, tx, waitForBlockAfter, wallet, type Wallet } from "./lib/chain.js";
import { encryptBundle } from "./lib/crypto.js";
import { sampleTasks } from "./lib/datasets.js";
import { generateJunkTasks, generateTasks } from "./lib/generators.js";
import { buildTaskTree, proofForIndex, sampleIndicesFor, type TaskTree } from "./lib/merkle.js";
import { getProvider, type ModelProvider } from "./lib/models.js";
import { loadState, saveState } from "./lib/state.js";
import { fmt, insideBand, measureBundle, type ClaimSpec, type Transcript } from "./lib/verify.js";
import { bountyCreatedEvents } from "./lib/events.js";

type OnChainSpec = {
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
  runParamsHash: Hex;
};

export function toClaimSpec(s: OnChainSpec): ClaimSpec {
  return {
    weakModel: s.weakModel,
    strongModel: s.strongModel,
    weakMaxBps: s.weakMaxBps,
    strongMinBps: s.strongMinBps,
    nullMaxBps: s.nullMaxBps,
    runs: s.runs,
    toleranceBps: s.toleranceBps,
  };
}

export interface Prepared {
  bundle: Bundle;
  bytesHex: Hex;
  commitment: Hex;
  root: Hex;
  transcript: Transcript;
  difficulty: number;
}

export interface PrepareOptions {
  seed: string;
  junk?: boolean;
  /** Ship this difficulty regardless of the band and claim the band anyway (dishonest seller). */
  forceDifficulty?: number;
  who?: string;
}

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Generate, measure and (for honest sellers) tune a bundle until it sits inside the band. */
export async function prepareBundle(spec: OnChainSpec, provider: ModelProvider, opts: PrepareOptions): Promise<Prepared> {
  const who = opts.who ?? "seller";
  if (runParamsHash(DEFAULT_RUN_PARAMS) !== spec.runParamsHash) {
    throw new Error("bounty pins run params I do not know; skipping");
  }
  const claim = toClaimSpec(spec);
  let difficulty = opts.forceDifficulty ?? 3;
  const tried = new Set<number>();
  for (let attempt = 0; attempt < 6; attempt++) {
    tried.add(difficulty);
    // Real benchmark items (BBH + GSM8K snapshots) by default; TASK_SOURCE=synthetic uses the procedural generators.
    const gen = opts.junk ? generateJunkTasks : process.env.TASK_SOURCE === "synthetic" ? generateTasks : sampleTasks;
    const tasks = gen({ seed: `${opts.seed}-d${difficulty}`, count: spec.taskCount, difficulty });
    const bundle: Bundle = {
      version: 1,
      salt: randomSalt(),
      domainTag: spec.domainTag,
      runParams: DEFAULT_RUN_PARAMS,
      tasks,
      sellerMeasured: { weak: 0, strong: 0, null: 0 },
    };
    const transcript = await measureBundle(bundle, claim, provider, "0x", {});
    const s = transcript.scores;
    log(who, `measured difficulty ${difficulty}: weak ${fmt(s.weak)} strong ${fmt(s.strong)} null ${fmt(s.null)}  (band: weak<=${fmt(spec.weakMaxBps)} strong>=${fmt(spec.strongMinBps)} null<=${fmt(spec.nullMaxBps)})`);

    const dishonest = opts.junk || opts.forceDifficulty !== undefined;
    if (dishonest) {
      // Lie: advertise numbers inside the band. The contract does not trust this field; the buyer reruns.
      bundle.sellerMeasured = { weak: Math.max(0, spec.weakMaxBps - 500), strong: Math.min(10_000, spec.strongMinBps + 500), null: 0 };
      log(who, `(dishonest) advertising weak ${fmt(bundle.sellerMeasured.weak)} strong ${fmt(bundle.sellerMeasured.strong)} instead of the measured numbers`);
      return finish(bundle, transcript, difficulty);
    }
    if (insideBand(s, claim)) {
      bundle.sellerMeasured = { ...s };
      return finish(bundle, transcript, difficulty);
    }
    // tune
    let next = difficulty;
    if (s.weak > spec.weakMaxBps) next = difficulty + 1;
    else if (s.strong < spec.strongMinBps) next = difficulty - 1;
    if (next < 1 || next > 5 || tried.has(next)) throw new Error(`cannot tune into the band (last scores weak ${fmt(s.weak)} strong ${fmt(s.strong)})`);
    log(who, `outside band -> retune difficulty ${difficulty} -> ${next}`);
    difficulty = next;
  }
  throw new Error("gave up tuning");

  function finish(bundle: Bundle, transcript: Transcript, d: number): Prepared {
    const bytes = bundleBytes(bundle);
    const tree = buildTaskTree(bundle.tasks);
    return { bundle, bytesHex: bytesToHex(bytes), commitment: bundleCommitment(bundle), root: tree.root as Hex, transcript, difficulty: d };
  }
}

export function treeOf(p: Prepared): TaskTree {
  return buildTaskTree(p.bundle.tasks);
}

export async function sellerCommit(w: Wallet, id: bigint, prep: Prepared, who = "seller") {
  const c = evalBounty(w);
  const bond = await c.read.minSellerBond([id]);
  log(who, `committing to bounty #${id}: root ${short(prep.root)} commitment ${short(prep.commitment)} bond ${eth(bond)} (${prep.bundle.tasks.length} tasks hidden)`);
  const r = await tx(who, `commit #${id}`, () => c.write.commit([id, prep.root, prep.commitment], { value: bond }));
  saveState(`seller-${w.account.address}-bounty-${id}`, { prep, committedBlock: r.blockNumber.toString() });
  return r;
}

export async function sellerReveal(w: Wallet, id: bigint, prep: Prepared, who = "seller") {
  const c = evalBounty(w);
  const b = await c.read.getBounty([id]);
  await waitForBlockAfter(b.sampleBlock, who);
  const block = await publicClient().getBlock({ blockNumber: b.sampleBlock });
  const idx = await c.read.sampleIndices([id]);
  const local = sampleIndicesFor(block.hash!, id, b.spec.taskCount, b.spec.sampleSize);
  if (local.join() !== idx.map(Number).join()) throw new Error(`local sample ${local} != on-chain ${idx}`);
  log(who, `blockhash(${b.sampleBlock}) = ${short(block.hash!)} picked tasks [${idx.join(", ")}] — I had no say in this`);
  const tree = treeOf(prep);
  const tasks = idx.map((i) => bytesToHex(taskBytes(prep.bundle.tasks[Number(i)]!)));
  for (const i of idx) {
    const t = prep.bundle.tasks[Number(i)]!;
    log(who, `  revealing task ${i} [${t.family}${t.sourceId ? ` · ${t.sourceId}` : ""}]`);
  }
  const proofs = idx.map((i) => proofForIndex(tree, Number(i)));
  return tx(who, `revealSample #${id}`, () => c.write.revealSample([id, tasks, proofs]));
}

export async function sellerDeliver(w: Wallet, id: bigint, prep: Prepared, who = "seller") {
  const c = evalBounty(w);
  const b = await c.read.getBounty([id]);
  const plaintext = new Uint8Array(Buffer.from(prep.bytesHex.slice(2), "hex"));
  const { ciphertext, key } = await encryptBundle(plaintext, b.buyerPubKey);
  saveState(`seller-${w.account.address}-key-${id}`, { key: bytesToHex(key) });
  log(who, `encrypting ${plaintext.length}-byte bundle to buyer key ${short(b.buyerPubKey)} -> ${ciphertext.length}-byte ciphertext`);
  return tx(who, `deliver #${id}`, () => c.write.deliver([id, bytesToHex(ciphertext)]));
}

export async function withdrawIfAny(w: Wallet, who: string) {
  const c = evalBounty(w);
  const owed = await c.read.pending([w.account.address]);
  if (owed === 0n) return;
  log(who, `withdrawing ${eth(owed)}`);
  await tx(who, "withdraw", () => c.write.withdraw());
}

// ------------------------------------------------------------------ long-running loop

export async function runSeller(opts: { junk?: boolean; forceDifficulty?: number; key?: Hex; who?: string; once?: boolean } = {}) {
  const who = opts.who ?? (opts.junk ? "junk" : "seller");
  const w = wallet(opts.key ?? env.key(opts.junk ? "JUNK_SELLER_KEY" : "SELLER_KEY"));
  const provider = await getProvider();
  const c = evalBounty(w);
  const attempted = new Set<string>();
  const lastStatus = new Map<string, number>();
  log(who, `online as ${w.account.address} (${provider.name} provider${opts.junk ? ", JUNK mode" : opts.forceDifficulty ? `, forced difficulty ${opts.forceDifficulty}` : ""})`);
  for (;;) {
    try {
      const created = await bountyCreatedEvents();
      for (const ev of created) {
        const id = ev.args.id;
        const b = await c.read.getBounty([id]);
        const mine = b.seller.toLowerCase() === w.account.address.toLowerCase();
        if (b.status === Status.Open && !attempted.has(id.toString())) {
          attempted.add(id.toString());
          log(who, `new bounty #${id} from ${short(b.buyer)}: ${b.spec.domainTag}, ${b.spec.taskCount} tasks, reward ${eth(b.reward)}`);
          const prep = await prepareBundle(b.spec, provider, { seed: `${w.account.address}-${id}`, junk: opts.junk, forceDifficulty: opts.forceDifficulty, who });
          await sellerCommit(w, id, prep, who);
          await sellerReveal(w, id, prep, who);
        } else if (mine && b.status === Status.Approved) {
          const st = loadState<{ prep: Prepared }>(`seller-${w.account.address}-bounty-${id}`);
          if (!st) throw new Error(`no prepared bundle for #${id}`);
          log(who, `buyer approved the sample of #${id}; delivering`);
          await sellerDeliver(w, id, st.prep, who);
        } else if (mine && (b.status === Status.Settled || b.status === Status.Refunded)) {
          // nothing to do; withdraw below
        } else if (!mine && attempted.has(id.toString()) && b.status === Status.Open) {
          // reopened after our sample was rejected: do not retry the same bundle
        }
        if (mine && lastStatus.get(id.toString()) !== b.status) {
          lastStatus.set(id.toString(), b.status);
          log(who, `#${id} is ${StatusName[b.status]}`);
        }
      }
      await withdrawIfAny(w, who);
    } catch (e) {
      log(who, `error: ${(e as Error).message}`);
    }
    if (opts.once) return;
    await sleep(env.chainName === "sepolia" ? 8000 : 1500);
  }
}

if (process.argv[1] && /seller\.ts$/.test(process.argv[1])) {
  const junk = process.argv.includes("--junk");
  const easy = process.argv.includes("--easy");
  runSeller({ junk, forceDifficulty: easy ? 1 : undefined }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { Address };
