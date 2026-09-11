/**
 * Event readers. The agents and the dashboard are driven entirely by EvalBounty events; storage
 * only holds hashes. Because a bounty can be re-committed after a rejection, "latest" readers
 * start from the most recent Committed event for that bounty.
 */
import { hexToBytes, type Address, type Hex } from "viem";
import { evalBountyAbi } from "./abi.js";
import { parseTask, type Task } from "./bundle.js";
import { env, publicClient } from "./chain.js";

function addr(): Address {
  const a = env.evalBounty;
  if (!a) throw new Error("EVALBOUNTY_ADDRESS not set");
  return a;
}

export async function bountyCreatedEvents(fromBlock = env.deployBlock) {
  return publicClient().getContractEvents({ address: addr(), abi: evalBountyAbi, eventName: "BountyCreated", fromBlock, toBlock: "latest", strict: true });
}

export async function latestCommitBlock(id: bigint): Promise<bigint> {
  const evs = await publicClient().getContractEvents({ address: addr(), abi: evalBountyAbi, eventName: "Committed", args: { id }, fromBlock: env.deployBlock, toBlock: "latest", strict: true });
  if (evs.length === 0) throw new Error(`bounty ${id} has no Committed event`);
  return evs[evs.length - 1]!.blockNumber;
}

export interface Revealed {
  index: number;
  bytes: Uint8Array;
  task: Task;
}

/** Tasks revealed in the current commit session of a bounty. */
export async function revealedTasks(id: bigint): Promise<Revealed[]> {
  const from = await latestCommitBlock(id);
  const evs = await publicClient().getContractEvents({ address: addr(), abi: evalBountyAbi, eventName: "SampleRevealed", args: { id }, fromBlock: from, toBlock: "latest", strict: true });
  return evs.map((e) => {
    const bytes = hexToBytes(e.args.task);
    return { index: Number(e.args.index), bytes, task: parseTask(bytes) };
  });
}

/** Ciphertext posted in the current commit session (lives only in the event log). */
export async function deliveredCiphertext(id: bigint): Promise<{ ciphertext: Uint8Array; txHash: Hex }> {
  const from = await latestCommitBlock(id);
  const evs = await publicClient().getContractEvents({ address: addr(), abi: evalBountyAbi, eventName: "Delivered", args: { id }, fromBlock: from, toBlock: "latest", strict: true });
  const e = evs[evs.length - 1];
  if (!e) throw new Error(`bounty ${id} has no Delivered event`);
  return { ciphertext: hexToBytes(e.args.ciphertext), txHash: e.transactionHash };
}

export async function latestDispute(id: bigint) {
  const from = await latestCommitBlock(id);
  const evs = await publicClient().getContractEvents({ address: addr(), abi: evalBountyAbi, eventName: "Disputed", args: { id }, fromBlock: from, toBlock: "latest", strict: true });
  const e = evs[evs.length - 1];
  if (!e) throw new Error(`bounty ${id} has no Disputed event`);
  return { kind: Number(e.args.kind), disputeId: e.args.disputeId, evidence: e.args.evidence, ruleBy: e.args.ruleBy };
}

export async function disputedEvents(fromBlock = env.deployBlock) {
  return publicClient().getContractEvents({ address: addr(), abi: evalBountyAbi, eventName: "Disputed", fromBlock, toBlock: "latest", strict: true });
}
