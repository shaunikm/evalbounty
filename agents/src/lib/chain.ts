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
import { foundry, sepolia } from "viem/chains";
import { arbitratorAbi, evalBountyAbi } from "./abi.js";

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
  key(name: KeyName): Hex {
    const v = process.env[name];
    if (!v) throw new Error(`${name} missing from agents/.env`);
    return v as Hex;
  },
  address(name: KeyName): Address {
    return privateKeyToAccount(env.key(name)).address;
  },
};

export function chain(): Chain {
  return env.chainName === "sepolia" ? sepolia : foundry;
}

export const explorer = {
  tx: (hash: Hex) => (env.chainName === "sepolia" ? `https://sepolia.etherscan.io/tx/${hash}` : `tx ${hash.slice(0, 14)}…`),
  address: (a: Address) => (env.chainName === "sepolia" ? `https://sepolia.etherscan.io/address/${a}` : a),
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

export function wallet(privateKey: Hex): Wallet {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chain(),
    transport: http(env.rpcUrl, { retryCount: 5 }),
  });
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

/** Send a write, wait for the receipt, log an explorer link, return the receipt. */
export async function tx(who: string, label: string, send: () => Promise<Hex>) {
  const hash = await send();
  const receipt = await publicClient().waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  log(who, `${label}  ${explorer.tx(hash)}`);
  return receipt;
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
    await sleep(env.chainName === "sepolia" ? 4000 : 300);
  }
}
