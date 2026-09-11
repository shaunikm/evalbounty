/**
 * viem clients, environment, contract handles and event helpers shared by all agents.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { arbitratorAbi, committeeAbi, evalBountyAbi } from "./abi.js";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = resolve(here, "../..");
export const STATE_DIR = resolve(AGENTS_DIR, "state");
export const REPO_DIR = resolve(AGENTS_DIR, "..");
loadEnv({ path: resolve(AGENTS_DIR, ".env"), quiet: true });

export type KeyName = "DEPLOYER_KEY" | "BUYER_KEY" | "SELLER_KEY" | "ARBITER_KEY" | "JUNK_SELLER_KEY";

export const env = {
  get rpcUrl() {
    return process.env.RPC_URL ?? "http://127.0.0.1:8545";
  },
  get chainName() {
    return process.env.CHAIN ?? "anvil";
  },
  get evalBounty() {
    return (process.env.EVALBOUNTY_ADDRESS || undefined) as Address | undefined;
  },
  get arbitrator() {
    return (process.env.ARBITRATOR_ADDRESS || undefined) as Address | undefined;
  },
  get deployBlock() {
    return BigInt(process.env.DEPLOY_BLOCK || "0");
  },
  get committee() {
    return (process.env.COMMITTEE_ADDRESS || undefined) as Address | undefined;
  },
  key(name: KeyName): Hex {
    const v = process.env[name];
    if (!v) throw new Error(`${name} missing from agents/.env`);
    return v as Hex;
  },
  address(name: KeyName): Address {
    return privateKeyToAccount(env.key(name)).address;
  },
};

/**
 * CHAIN may be a viem chain name ("sepolia", "anvil"/"foundry", "baseSepolia", ...) or a numeric chain id.
 * Nothing else in the agents is chain-specific; explorer links come from the chain definition.
 */
export function chain(): Chain {
  const name = env.chainName;
  if (name === "anvil") return chains.foundry;
  if (/^\d+$/.test(name)) {
    const byId = Object.values(chains).find((c) => typeof c === "object" && c !== null && "id" in c && (c as Chain).id === Number(name)) as Chain | undefined;
    if (byId) return byId;
  }
  const byName = (chains as Record<string, unknown>)[name] as Chain | undefined;
  if (byName && typeof byName === "object" && "id" in byName) return byName;
  throw new Error(`unknown CHAIN "${name}"; use a viem chain name (sepolia, foundry, baseSepolia, ...) or a chain id`);
}

export function explorerBase(): string | undefined {
  return chain().blockExplorers?.default?.url;
}

export const explorer = {
  tx: (hash: Hex) => (explorerBase() ? `${explorerBase()}/tx/${hash}` : `tx ${hash.slice(0, 14)}…`),
  address: (a: Address) => (explorerBase() ? `${explorerBase()}/address/${a}` : a),
};

export type Wallet = WalletClient<Transport, Chain, Account>;

let _pc: PublicClient | undefined;
export function publicClient(): PublicClient {
  if (!_pc) _pc = createPublicClient({ chain: chain(), transport: http(env.rpcUrl, { retryCount: 5 }) });
  return _pc;
}
export function resetClients() {
  _pc = undefined;
}

const secrets = new WeakMap<object, Hex>();

export function wallet(privateKey: Hex): Wallet {
  const w = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chain(),
    transport: http(env.rpcUrl, { retryCount: 5 }),
  });
  secrets.set(w, privateKey);
  return w;
}

/** The private key a wallet was created with (never logged; used to derive per-bounty keys). */
export function secretOf(w: Wallet): Hex {
  const k = secrets.get(w);
  if (!k) throw new Error("wallet was not created with wallet(); cannot derive keys");
  return k;
}

function evalBountyAddress(): Address {
  const a = env.evalBounty;
  if (!a) throw new Error("EVALBOUNTY_ADDRESS not set; run `pnpm deploy-contracts` first");
  return a;
}
function arbitratorAddress(): Address {
  const a = env.arbitrator;
  if (!a) throw new Error("ARBITRATOR_ADDRESS not set; run `pnpm deploy-contracts` first");
  return a;
}
const evalBountyRO = (address: Address) => getContract({ address, abi: evalBountyAbi, client: publicClient() });
const evalBountyRW = (address: Address, w: Wallet) => getContract({ address, abi: evalBountyAbi, client: { public: publicClient(), wallet: w } });
const arbitratorRO = (address: Address) => getContract({ address, abi: arbitratorAbi, client: publicClient() });
const arbitratorRW = (address: Address, w: Wallet) => getContract({ address, abi: arbitratorAbi, client: { public: publicClient(), wallet: w } });
export type EvalBountyRO = ReturnType<typeof evalBountyRO>;
export type EvalBountyRW = ReturnType<typeof evalBountyRW>;

/** Read-only handle without a wallet; read+write handle with one. */
export function evalBounty(): EvalBountyRO;
export function evalBounty(w: Wallet): EvalBountyRW;
export function evalBounty(w?: Wallet): EvalBountyRO | EvalBountyRW {
  return w ? evalBountyRW(evalBountyAddress(), w) : evalBountyRO(evalBountyAddress());
}

export function arbitrator(): ReturnType<typeof arbitratorRO>;
export function arbitrator(w: Wallet): ReturnType<typeof arbitratorRW>;
export function arbitrator(w?: Wallet) {
  return w ? arbitratorRW(arbitratorAddress(), w) : arbitratorRO(arbitratorAddress());
}

const committeeRO = (address: Address) => getContract({ address, abi: committeeAbi, client: publicClient() });
const committeeRW = (address: Address, w: Wallet) => getContract({ address, abi: committeeAbi, client: { public: publicClient(), wallet: w } });
export type CommitteeRO = ReturnType<typeof committeeRO>;
export type CommitteeRW = ReturnType<typeof committeeRW>;

/** Committee arbitrator handle. Pass the address (usually EvalBounty.arbitrator()) or rely on COMMITTEE_ADDRESS. */
export function committee(address?: Address): CommitteeRO;
export function committee(address: Address | undefined, w: Wallet): CommitteeRW;
export function committee(address?: Address, w?: Wallet) {
  const a = address ?? env.committee;
  if (!a) throw new Error("COMMITTEE_ADDRESS not set; run `pnpm deploy-contracts -- --committee`");
  return w ? committeeRW(a, w) : committeeRO(a);
}

/** Is this arbitrator address a CommitteeArbitrator (has panelSize) or a single-key arbitrator? */
export async function arbitratorKind(address: Address): Promise<"committee" | "single"> {
  try {
    await committeeRO(address).read.panelSize();
    return "committee";
  } catch {
    return "single";
  }
}

export const Status = {
  Open: 0,
  Committed: 1,
  Sampled: 2,
  Approved: 3,
  Delivered: 4,
  Disputed: 5,
  Settled: 6,
  Refunded: 7,
  Cancelled: 8,
} as const;
export const StatusName = Object.fromEntries(Object.entries(Status).map(([k, v]) => [v, k])) as Record<number, string>;
export const DisputeKind = { BadDelivery: 0, ClaimsFailed: 1 } as const;
export const Ruling = { Refused: 0n, Seller: 1n, Buyer: 2n } as const;

// ------------------------------------------------------------------ logging

const t0 = Date.now();
export function log(who: string, msg: string) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`${s}s [${who.padEnd(7)}] ${msg}`);
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4)} ETH`;

// ------------------------------------------------------------------ tx helper

const TRANSIENT = /HttpRequestError|TimeoutError|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|429|502|503|504|rate limit|nonce too low|replacement transaction underpriced|already known/i;

/**
 * Send a write, wait for the receipt, log an explorer link, return the receipt.
 * Network-level failures (public RPC hiccups, rate limits, nonce races) are retried with backoff;
 * contract reverts are not, because they mean the state machine disagrees and retrying is wrong.
 */
export async function tx(who: string, label: string, send: () => Promise<Hex>, attempts = 4) {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const hash = await send();
      const receipt = await publicClient().waitForTransactionReceipt({ hash, confirmations: 1, timeout: 600_000 });
      if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
      log(who, `${label}  ${explorer.tx(hash)}`);
      return receipt;
    } catch (e) {
      lastErr = e;
      const msg = `${(e as Error).name ?? ""} ${(e as Error).message ?? ""}`;
      if (i === attempts || !TRANSIENT.test(msg)) throw e;
      const wait = 3000 * i;
      log(who, `${label}: transient RPC error (${msg.split("\n")[0].slice(0, 90)}); retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Resolve once block.number > target (i.e. blockhash(target) is available). */
export async function waitForBlockAfter(target: bigint, who = "chain") {
  const pc = publicClient();
  for (;;) {
    const n = await pc.getBlockNumber({ cacheTime: 0 });
    if (n > target) return n;
    log(who, `waiting for block ${target + 1n} (now ${n}) so blockhash(${target}) is fixed`);
    await sleep(chain().id === chains.foundry.id ? 300 : 4000);
  }
}
