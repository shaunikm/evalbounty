/**
 * Juror agent for the CommitteeArbitrator.
 *
 *   stake once (X25519 key derived from the wallet, registered on-chain)
 *   on DisputeCreation: draw the panel once the sortition block has passed (anyone may)
 *   if drawn: reproduce the check — BadDelivery from the public evidence; ClaimsFailed once the
 *             buyer has sealed the bundle key to this juror — with more runs than the buyer used,
 *             vote 1 (seller), 2 (buyer) or 0 (too close to call), commit the hash, reveal later
 *   execute once every juror revealed or the reveal window closed (anyone may)
 *
 * One process can run several juror wallets (JUROR_KEYS=0x..,0x..) — handy for a demo, not for
 * real independence.
 */
import { decodeAbiParameters, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { evaluateDispute } from "./arbiter.js";
import { committeeAbi, evalBountyAbi } from "./lib/abi.js";
import { chain, committee, env, eth, evalBounty, log, publicClient, secretOf, short, sleep, tx, wallet, type Wallet } from "./lib/chain.js";
import { deriveBytes32, deriveKeyPair, openSealedKey, type KeyPairHex } from "./lib/crypto.js";
import { getProvider, type ModelProvider } from "./lib/models.js";
import { loadState, saveState } from "./lib/state.js";

export const JUROR_RUNS_MULTIPLIER = Number(process.env.JUROR_RUNS_MULTIPLIER ?? 2);

export function jurorKeyPair(w: Wallet, committeeAddr: Address): Promise<KeyPairHex> {
  return deriveKeyPair(secretOf(w), `evalbounty/v1/juror/${chain().id}/${committeeAddr.toLowerCase()}/${w.account.address.toLowerCase()}`);
}

/** Stake (or top up) so this wallet is eligible for sortition, and register its X25519 key. */
export async function ensureStaked(w: Wallet, committeeAddr: Address, amount?: bigint, who = "juror") {
  const cm = committee(committeeAddr, w);
  const kp = await jurorKeyPair(w, committeeAddr);
  const [stake, pubKey] = await cm.read.jurorInfo([w.account.address]);
  const minStake = await cm.read.minStake();
  const target = amount ?? minStake;
  if (stake < target) {
    await tx(who, `stake ${eth(target - stake)} as juror ${short(w.account.address)}`, () => cm.write.stake([kp.publicKey as Hex], { value: target - stake }));
  } else if (pubKey.toLowerCase() !== kp.publicKey.toLowerCase()) {
    await tx(who, `setJurorKey ${short(kp.publicKey)}`, () => cm.write.setJurorKey([kp.publicKey as Hex]));
  }
}

export interface DisputeContext {
  bountyId: bigint;
  kind: number;
  evidence: Hex;
}

/** Map a committee dispute id back to the market bounty via the market's Disputed events. */
export async function disputeContext(disputeId: bigint, committeeAddr: Address): Promise<DisputeContext | undefined> {
  const pc = publicClient();
  const evs = await pc.getContractEvents({ address: evalBounty().address, abi: evalBountyAbi, eventName: "Disputed", fromBlock: env.deployBlock, toBlock: "latest", strict: true });
  for (const e of evs) {
    if (e.args.disputeId !== disputeId) continue;
    const b = await evalBounty().read.getBounty([e.args.id]);
    if (b.arbitrator.toLowerCase() !== committeeAddr.toLowerCase() || b.disputeId !== disputeId) continue;
    return { bountyId: e.args.id, kind: Number(e.args.kind), evidence: e.args.evidence };
  }
  return undefined;
}

/**
 * The wallet with the most gas money. Permissionless calls (drawPanel, execute) go through it so a
 * juror wallet that ran dry never stalls a panel it is not even required to pay for.
 */
export async function richest(wallets: Wallet[]): Promise<Wallet> {
  if (wallets.length === 0) throw new Error("no juror wallets");
  const pc = publicClient();
  let best = wallets[0]!;
  let bestBalance = -1n;
  for (const w of wallets) {
    const bal = await pc.getBalance({ address: w.account.address });
    if (bal > bestBalance) {
      best = w;
      bestBalance = bal;
    }
  }
  return best;
}

export async function drawIfNeeded(w: Wallet, committeeAddr: Address, disputeId: bigint, who = "juror"): Promise<Address[]> {
  const cm = committee(committeeAddr, w);
  const d = await cm.read.getDispute([disputeId]);
  const [, , , status, sortitionBlock, panel] = d;
  if (panel.length > 0 || status !== 0) return [...panel] as Address[];
  const head = await publicClient().getBlockNumber({ cacheTime: 0 });
  if (head <= sortitionBlock) return [];
  await tx(who, `drawPanel(dispute ${disputeId}) from blockhash(${sortitionBlock})`, () => cm.write.drawPanel([disputeId]));
  // Re-read with patience: load-balanced RPCs may still serve pre-tx state for a moment.
  let drawn: Address[] = [];
  for (let i = 0; i < 10 && drawn.length === 0; i++) {
    const after = await cm.read.getDispute([disputeId]);
    drawn = [...after[5]] as Address[];
    if (drawn.length === 0) {
      if (after[4] !== sortitionBlock) {
        log(who, `blockhash(${sortitionBlock}) had expired; the panel re-rolls from block ${after[4]}`);
        return [];
      }
      await sleep(env.chainName === "anvil" ? 100 : 1000);
    }
  }
  if (drawn.length) log(who, `panel for dispute ${disputeId}: ${drawn.map(short).join(", ")} — chosen by the chain, not by either party`);
  return drawn;
}

/** The sealed bundle key the buyer posted for this juror, if any yet. */
async function sealedKeyFor(committeeAddr: Address, disputeId: bigint, myIndex: number): Promise<Uint8Array | undefined> {
  const evs = await publicClient().getContractEvents({ address: committeeAddr, abi: committeeAbi, eventName: "KeysSubmitted", args: { disputeID: disputeId }, fromBlock: env.deployBlock, toBlock: "latest", strict: true });
  const e = evs[evs.length - 1];
  if (!e) return undefined;
  const hex = e.args.sealedKeys[myIndex];
  return hex ? new Uint8Array(Buffer.from(hex.slice(2), "hex")) : undefined;
}

/** Decide this juror's vote. Returns undefined if the evidence needed is not available yet. */
export async function decideVote(w: Wallet, committeeAddr: Address, disputeId: bigint, provider: ModelProvider, who = "juror"): Promise<{ vote: number; why: string } | undefined> {
  const ctx = await disputeContext(disputeId, committeeAddr);
  if (!ctx) return undefined;
  const cm = committee(committeeAddr);
  const panel = [...(await cm.read.panelOf([disputeId]))].map((a) => a.toLowerCase());
  const myIndex = panel.indexOf(w.account.address.toLowerCase());
  if (myIndex < 0) return undefined;
  let bundleKey: Uint8Array | undefined;
  if (ctx.kind === 1) {
    const sealed = await sealedKeyFor(committeeAddr, disputeId, myIndex);
    if (!sealed) return undefined; // buyer has not handed the key over yet
    try {
      bundleKey = await openSealedKey(sealed, await jurorKeyPair(w, committeeAddr));
    } catch (e) {
      log(who, `dispute ${disputeId}: sealed key does not open for me (${(e as Error).message}); buyer failed to substantiate -> seller`);
      return { vote: 1, why: "sealed key unusable" };
    }
  }
  const decision = await evaluateDispute(ctx.bountyId, provider, { bundleKey, runsMultiplier: JUROR_RUNS_MULTIPLIER, tooCloseToCall: true, who });
  return { vote: Number(decision.ruling), why: decision.evidence };
}

function saltFor(w: Wallet, committeeAddr: Address, disputeId: bigint) {
  return deriveBytes32(secretOf(w), `evalbounty/v1/juror-salt/${chain().id}/${committeeAddr.toLowerCase()}/${disputeId}`);
}

export async function commitVote(w: Wallet, committeeAddr: Address, disputeId: bigint, vote: number, who = "juror") {
  const salt = await saltFor(w, committeeAddr, disputeId);
  const commitment = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" }], [disputeId, vote, salt, w.account.address]));
  await tx(who, `commitVote(dispute ${disputeId}) as ${short(w.account.address)} (vote hidden)`, () => committee(committeeAddr, w).write.commitVote([disputeId, commitment]));
  saveState(`juror-${w.account.address}-vote-${disputeId}`, { vote, salt });
}

export async function revealVote(w: Wallet, committeeAddr: Address, disputeId: bigint, who = "juror") {
  const st = loadState<{ vote: number; salt: Hex }>(`juror-${w.account.address}-vote-${disputeId}`);
  if (!st) throw new Error(`no committed vote for dispute ${disputeId}`);
  await tx(who, `revealVote(dispute ${disputeId}) = ${["refuse (too close)", "seller", "buyer"][st.vote] ?? st.vote} by ${short(w.account.address)}`, () =>
    committee(committeeAddr, w).write.revealVote([disputeId, st.vote, st.salt]),
  );
}

export async function executeIfReady(w: Wallet, committeeAddr: Address, disputeId: bigint, who = "juror"): Promise<boolean> {
  const cm = committee(committeeAddr, w);
  const d = await cm.read.getDispute([disputeId]);
  const [, , , status, , panel, , revealBy, , revealed] = d;
  if (status !== 0 || panel.length === 0) return false;
  const now = BigInt((await publicClient().getBlock()).timestamp);
  if (revealed < panel.length && now <= BigInt(revealBy)) return false;
  await tx(who, `execute(dispute ${disputeId}): tally ${revealed}/${panel.length} reveals`, () => cm.write.execute([disputeId]));
  const after = await cm.read.getDispute([disputeId]);
  log(who, `dispute ${disputeId} ruled ${["refused → split", "seller wins", "buyer wins"][Number(after[2])] ?? after[2]}`);
  return true;
}

/** One pass over all open committee disputes for a set of juror wallets. Returns true if anything happened. */
export async function jurorPass(wallets: Wallet[], committeeAddr: Address, provider: ModelProvider, who = "juror"): Promise<boolean> {
  const cm = committee(committeeAddr);
  const n = await cm.read.disputeCount();
  const payer = await richest(wallets);
  let acted = false;
  for (let id = 0n; id < n; id++) {
    const d = await cm.read.getDispute([id]);
    if (d[3] !== 0) continue; // solved
    let panel = [...d[5]].map((a) => a.toLowerCase());
    if (panel.length === 0) {
      panel = (await drawIfNeeded(payer, committeeAddr, id, who)).map((a) => a.toLowerCase());
      if (panel.length === 0) continue;
      acted = true;
    }
    const commitBy = BigInt(d[6]);
    const now = BigInt((await publicClient().getBlock()).timestamp);
    let allCommitted = true;
    for (const p of panel) if ((await cm.read.commitments([id, p as Address])) === `0x${"0".repeat(64)}`) allCommitted = false;
    for (const w of wallets) {
      const me = w.account.address.toLowerCase();
      if (!panel.includes(me)) continue;
      const committed = (await cm.read.commitments([id, w.account.address])) !== `0x${"0".repeat(64)}`;
      const revealed = (await cm.read.revealedVote([id, w.account.address])) !== 0;
      if (!committed) {
        if (now > commitBy) continue;
        const decision = await decideVote(w, committeeAddr, id, provider, who);
        if (!decision) continue;
        log(who, `${short(me)} decided ${["refuse (too close)", "seller", "buyer"][decision.vote]} on dispute ${id}: ${decision.why.slice(0, 120)}`);
        await commitVote(w, committeeAddr, id, decision.vote, who);
        acted = true;
      } else if (!revealed && (now > commitBy || allCommitted)) {
        await revealVote(w, committeeAddr, id, who);
        acted = true;
      }
    }
    if (await executeIfReady(payer, committeeAddr, id, who)) acted = true;
  }
  return acted;
}

export function jurorWallets(): Wallet[] {
  const keys = (process.env.JUROR_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean) as Hex[];
  if (keys.length === 0) throw new Error("JUROR_KEYS is empty (comma-separated private keys)");
  return keys.map(wallet);
}

export async function runJurors(opts: { once?: boolean; who?: string } = {}) {
  const who = opts.who ?? "juror";
  const provider = await getProvider();
  const committeeAddr = (await evalBounty().read.arbitrator()) as Address;
  const wallets = jurorWallets();
  log(who, `${wallets.length} juror wallet(s) online against committee ${committeeAddr} (${provider.name} provider, ${JUROR_RUNS_MULTIPLIER}x the buyer's runs)`);
  for (const w of wallets) await ensureStaked(w, committeeAddr, undefined, who);
  for (;;) {
    try {
      // --once: keep going while progress is being made (commit -> reveal -> execute can all happen in one call)
      for (let round = 0; round < 4; round++) {
        const acted = await jurorPass(wallets, committeeAddr, provider, who);
        if (!acted || !opts.once) break;
      }
      for (const w of wallets) {
        const owed = await committee(committeeAddr).read.pending([w.account.address]);
        if (owed > 0n) await tx(who, `withdraw ${eth(owed)} juror earnings`, () => committee(committeeAddr, w).write.withdraw());
      }
    } catch (e) {
      log(who, `error: ${(e as Error).message.split("\n")[0]}`);
    }
    if (opts.once) return;
    await sleep(env.chainName === "anvil" ? 1500 : 8000);
  }
}

if (process.argv[1] && /juror\.ts$/.test(process.argv[1])) {
  runJurors({ once: process.argv.includes("--once") }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { decodeAbiParameters };
