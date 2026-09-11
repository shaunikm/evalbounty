/** Tiny JSON state store under agents/state (gitignored). Keys and prepared bundles live here. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_DIR, env } from "./chain.js";

/** Namespace per chain + contract so anvil runs and Sepolia runs never share a bounty's keys. */
function scoped(name: string): string {
  const c = env.evalBounty ? env.evalBounty.slice(2, 10).toLowerCase() : "nocontract";
  return `${env.chainName}_${c}_${name}`;
}

export function saveState<T>(name: string, value: T) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(resolve(STATE_DIR, `${scoped(name)}.json`), JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export function loadState<T>(name: string): T | undefined {
  const p = resolve(STATE_DIR, `${scoped(name)}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
