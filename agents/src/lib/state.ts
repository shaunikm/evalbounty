/** Tiny JSON state store under agents/state (gitignored). Keys and prepared bundles live here. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_DIR } from "./chain.js";

export function saveState<T>(name: string, value: T) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(resolve(STATE_DIR, `${name}.json`), JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export function loadState<T>(name: string): T | undefined {
  const p = resolve(STATE_DIR, `${name}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
