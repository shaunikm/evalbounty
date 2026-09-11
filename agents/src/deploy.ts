/**
 * Deploy CentralizedArbitrator + EvalBounty, fund the agent wallets from the deployer, and write
 * the addresses into agents/.env and dashboard/config.js.
 *
 *   CHAIN=anvil   pnpm deploy-contracts  (uses agents/.env keys; anvil must be running)
 *   CHAIN=sepolia pnpm deploy-contracts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { arbitratorAbi, arbitratorBytecode, evalBountyAbi, evalBountyBytecode } from "./lib/abi.js";
import { AGENTS_DIR, REPO_DIR, STATE_DIR, chain, env, eth, explorer, log, publicClient, wallet, type KeyName } from "./lib/chain.js";
import { deriveKeyPair, type KeyPairHex } from "./lib/crypto.js";

const MIN = 60n;
export const WINDOWS = {
  approve: BigInt(process.env.APPROVE_WINDOW ?? 30n * MIN),
  deliver: BigInt(process.env.DELIVER_WINDOW ?? 30n * MIN),
  verify: BigInt(process.env.VERIFY_WINDOW ?? 60n * MIN),
  rule: BigInt(process.env.RULE_WINDOW ?? 60n * MIN),
};
export const ARBITRATION_PRICE = parseEther("0.0002");
const META_EVIDENCE_URI = "https://github.com/shaunikm/technical-interview/blob/main/dashboard/meta-evidence.json";

// Enough for the four demo stories at ~1-2 gwei with margin; funded in this priority order.
// Real-item bundles are ~23 KB, so a delivery costs ~1M gas; the seller needs the most headroom.
const FUNDING: { name: string; key: KeyName; target: bigint }[] = [
  { name: "buyer", key: "BUYER_KEY", target: parseEther("0.015") },
  { name: "seller", key: "SELLER_KEY", target: parseEther("0.02") },
  { name: "arbiter", key: "ARBITER_KEY", target: parseEther("0.003") },
  { name: "junkSeller", key: "JUNK_SELLER_KEY", target: parseEther("0.004") },
];
const DEPLOYER_RESERVE = parseEther("0.002");

/** The arbiter's X25519 key is derived from its wallet key; nothing to back up. */
export async function loadOrCreateArbiterKeys(): Promise<KeyPairHex> {
  return deriveKeyPair(env.key("ARBITER_KEY"), `evalbounty/v1/arbiter/${chain().id}/${env.address("ARBITER_KEY").toLowerCase()}`);
}

/** Pre-derivation random key file, kept only to open disputes sealed before the switch. */
export function legacyArbiterKeys(): KeyPairHex | undefined {
  const p = resolve(STATE_DIR, "arbiter-x25519.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as KeyPairHex) : undefined;
}

function setEnvVar(file: string, key: string, value: string) {
  let s = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  s = re.test(s) ? s.replace(re, `${key}=${value}`) : s + `\n${key}=${value}`;
  writeFileSync(file, s);
}


/** Top agents up to their targets, in priority order, keeping a small reserve for the deployer. */
export async function fundAgents(deployer = wallet(env.key("DEPLOYER_KEY"))) {
  const pc = publicClient();
  for (const f of FUNDING) {
    const addr = env.address(f.key);
    const have = await pc.getBalance({ address: addr });
    if (have >= f.target) {
      log("deploy", `${f.name} ${addr} already has ${eth(have)}`);
      continue;
    }
    const deployerBal = await pc.getBalance({ address: deployer.account.address });
    const available = deployerBal > DEPLOYER_RESERVE ? deployerBal - DEPLOYER_RESERVE : 0n;
    const want = f.target - have;
    const amount = want < available ? want : available;
    if (amount <= 0n) {
      log("deploy", `cannot fund ${f.name}: deployer is down to ${eth(deployerBal)}; top it up and rerun`);
      continue;
    }
    const hash = await deployer.sendTransaction({ to: addr, value: amount });
    await pc.waitForTransactionReceipt({ hash });
    log("deploy", `funded ${f.name} ${addr} +${eth(amount)}${amount < want ? `  (short by ${eth(want - amount)})` : ""}`);
  }
}

export interface Deployment {
  evalBountyAddress: Address;
  arbitratorAddress: Address;
  deployBlock: bigint;
  arbiterKp: KeyPairHex;
}

export async function deploy(opts: { fund?: boolean; persist?: boolean } = {}): Promise<Deployment> {
  const fund = opts.fund ?? true;
  const persist = opts.persist ?? true;
  const pc = publicClient();
  const deployer = wallet(env.key("DEPLOYER_KEY"));
  const arbiterAddr = env.address("ARBITER_KEY");
  const bal = await pc.getBalance({ address: deployer.account.address });
  log("deploy", `chain=${env.chainName} deployer=${deployer.account.address} balance=${eth(bal)}`);
  const need = fund ? parseEther("0.02") : parseEther("0.008");
  if (bal < need) {
    throw new Error(`deployer needs at least ${eth(need)} (0.05 recommended); has ${eth(bal)}. Fund ${deployer.account.address}`);
  }

  const arbiterKp = await loadOrCreateArbiterKeys();

  const h1 = await deployer.deployContract({
    abi: arbitratorAbi,
    bytecode: arbitratorBytecode as Hex,
    args: [arbiterAddr, ARBITRATION_PRICE, arbiterKp.publicKey as Hex],
  });
  const r1 = await pc.waitForTransactionReceipt({ hash: h1 });
  const arbitratorAddress = r1.contractAddress as Address;
  log("deploy", `CentralizedArbitrator at ${arbitratorAddress}  ${explorer.tx(h1)}`);

  const h2 = await deployer.deployContract({
    abi: evalBountyAbi,
    bytecode: evalBountyBytecode as Hex,
    args: [arbitratorAddress, deployer.account.address, WINDOWS, META_EVIDENCE_URI],
  });
  const r2 = await pc.waitForTransactionReceipt({ hash: h2 });
  const evalBountyAddress = r2.contractAddress as Address;
  log("deploy", `EvalBounty at ${evalBountyAddress} (block ${r2.blockNumber})  ${explorer.tx(h2)}`);

  if (fund) await fundAgents(deployer);

  process.env.EVALBOUNTY_ADDRESS = evalBountyAddress;
  process.env.ARBITRATOR_ADDRESS = arbitratorAddress;
  process.env.DEPLOY_BLOCK = r2.blockNumber.toString();

  if (persist) {
    const envFile = resolve(AGENTS_DIR, ".env");
    setEnvVar(envFile, "EVALBOUNTY_ADDRESS", evalBountyAddress);
    setEnvVar(envFile, "ARBITRATOR_ADDRESS", arbitratorAddress);
    setEnvVar(envFile, "DEPLOY_BLOCK", r2.blockNumber.toString());
    if (env.chainName !== "anvil") {
      const cfg = `// Generated by agents/src/deploy.ts on ${new Date().toISOString()}
window.EVALBOUNTY_CONFIG = {
  chainId: ${chain().id},
  contractAddress: "${evalBountyAddress}",
  arbitratorAddress: "${arbitratorAddress}",
  deployBlock: ${r2.blockNumber.toString()},
  rpcUrl: ${JSON.stringify(env.rpcUrl)},
  arbiterPubKey: "${arbiterKp.publicKey}",
  agents: {
    buyer: "${env.address("BUYER_KEY")}",
    seller: "${env.address("SELLER_KEY")}",
    arbiter: "${arbiterAddr}",
    junkSeller: "${env.address("JUNK_SELLER_KEY")}"
  }
};
`;
      mkdirSync(resolve(REPO_DIR, "dashboard"), { recursive: true });
      writeFileSync(resolve(REPO_DIR, "dashboard/config.js"), cfg);
      log("deploy", "wrote dashboard/config.js");
    }
  }
  return { evalBountyAddress, arbitratorAddress, deployBlock: r2.blockNumber, arbiterKp };
}

if (process.argv[1] && /deploy\.ts$/.test(process.argv[1])) {
  const run = process.argv.includes("--fund-only") ? fundAgents() : deploy();
  run.catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
