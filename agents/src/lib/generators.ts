/**
 * Procedural task generators with computed references.
 *
 * Every task family produces a prompt whose answer is computed by construction, so the answer key
 * is correct by definition and difficulty is tuned by operand size / chain length rather than by
 * filtering on model failures (the "answer-key bias" that hit SWE-bench Verified and HLE).
 */
import { keccak256, toHex } from "viem";
import type { Grader, Task } from "./bundle.js";

// ------------------------------------------------------------------ seeded RNG

export class Rng {
  private s: number;
  constructor(seed: string) {
    this.s = Number(BigInt(keccak256(toHex(seed))) & 0xffffffffn) || 1;
  }
  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  bigint(digits: number): bigint {
    let s = String(this.int(1, 9));
    for (let i = 1; i < digits; i++) s += String(this.int(0, 9));
    return BigInt(s);
  }
}

export interface Generated {
  family: string;
  prompt: string;
  reference: string;
  grader: Grader;
}

export type Family = "arith" | "modular" | "date" | "strings" | "units" | "sequence";
export const FAMILIES: Family[] = ["arith", "modular", "date", "strings", "units", "sequence"];

const numeric = (value: string | number | bigint, tolerance = 0): Grader => ({
  type: "numeric",
  value: String(value),
  tolerance,
});
const exact = (value: string): Grader => ({ type: "exact", value });

// ------------------------------------------------------------------ families

function arith(r: Rng, d: number): Generated {
  // difficulty 1 is deliberately trivial (one op on 1-2 digit numbers): it is what a dishonest
  // seller ships while claiming the band, and a weak model must be able to solve it.
  const digits = d === 1 ? 2 : 3 + d;
  const ops = d === 1 ? 1 : d + 1;
  let expr = r.bigint(digits).toString();
  let value = BigInt(expr);
  for (let i = 0; i < ops; i++) {
    const op = r.pick(["+", "-", "*"] as const);
    const operand = op === "*" ? r.bigint(Math.max(2, Math.floor(digits / 2))) : r.bigint(digits);
    if (op === "*") {
      expr = `(${expr}) * ${operand}`;
      value = value * operand;
    } else if (op === "+") {
      expr = `${expr} + ${operand}`;
      value = value + operand;
    } else {
      expr = `${expr} - ${operand}`;
      value = value - operand;
    }
  }
  return {
    family: "arith",
    prompt: `Compute the exact integer value of ${expr}. Reply with only the integer.`,
    reference: value.toString(),
    grader: numeric(value),
  };
}

function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let result = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modular(r: Rng, d: number): Generated {
  const base = d === 1 ? BigInt(r.int(2, 9)) : r.bigint(1 + d);
  const exp = d === 1 ? 2n : r.bigint(2 + d);
  const mod = d === 1 ? BigInt(r.int(5, 12)) : BigInt(r.int(97, 97 + 200 * d)) * 2n + 1n;
  const value = modpow(base, exp, mod);
  return {
    family: "modular",
    prompt: `What is ${base}^${exp} mod ${mod}? Reply with only the integer.`,
    reference: value.toString(),
    grader: numeric(value),
  };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(r: Rng, yMin: number, yMax: number): { iso: string; ms: number } {
  const y = r.int(yMin, yMax);
  const m = r.int(1, 12);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = r.int(1, dim);
  return { iso: `${y}-${pad(m)}-${pad(day)}`, ms: Date.UTC(y, m - 1, day) };
}

function date(r: Rng, d: number): Generated {
  if (d === 1) {
    // trivial: weekday a few days after a named weekday
    const start = r.int(0, 6);
    const k = r.int(1, 3);
    const target = DAYS[(start + k) % 7]!;
    return {
      family: "date",
      prompt: `What day of the week is ${k} day${k > 1 ? "s" : ""} after ${DAYS[start]}? Reply with only the weekday name.`,
      reference: target,
      grader: exact(target),
    };
  }
  const spread = 2 * d;
  if (r.next() < 0.5) {
    const a = isoDate(r, 1950, 2049);
    const y0 = Number(a.iso.slice(0, 4));
    const b = isoDate(r, y0, Math.min(2049, y0 + spread));
    const [x, y] = a.ms <= b.ms ? [a, b] : [b, a];
    const days = Math.round((y.ms - x.ms) / 86_400_000);
    return {
      family: "date",
      prompt: `How many days are there from ${x.iso} to ${y.iso} (count the end date, not the start date)? Reply with only the integer.`,
      reference: String(days),
      grader: numeric(days),
    };
  }
  const a = isoDate(r, 1800 + 40 * (5 - d), 2099);
  const offset = r.int(1, 30 * d);
  const target = new Date(a.ms + offset * 86_400_000);
  const weekday = DAYS[target.getUTCDay()]!;
  return {
    family: "date",
    prompt: `What day of the week is ${offset} days after ${a.iso} (Gregorian calendar)? Reply with only the weekday name.`,
    reference: weekday,
    grader: exact(weekday),
  };
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz";

function strings(r: Rng, d: number): Generated {
  if (d === 1) {
    const n = r.int(3, 6);
    let w = "";
    for (let i = 0; i < n; i++) w += ALPHA[r.int(0, 25)];
    return { family: "strings", prompt: `How many letters are in the string "${w}"? Reply with only the integer.`, reference: String(n), grader: numeric(n) };
  }
  const len = 5 + 2 * d;
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHA[r.int(0, 25)];
  const steps: string[] = [];
  let cur = s;
  const nSteps = 1 + d;
  for (let i = 0; i < nSteps; i++) {
    const kind = r.int(0, 3);
    if (kind === 0) {
      cur = [...cur].reverse().join("");
      steps.push("reverse the string");
    } else if (kind === 1) {
      const k = r.int(1, Math.max(1, cur.length - 1));
      cur = cur.slice(k) + cur.slice(0, k);
      steps.push(`move the first ${k} characters to the end`);
    } else if (kind === 2) {
      const shift = r.int(1, 25);
      cur = [...cur]
        .map((c) => (ALPHA.includes(c) ? ALPHA[(ALPHA.indexOf(c) + shift) % 26]! : c.toLowerCase()))
        .join("");
      steps.push(
        `shift every letter forward by ${shift} positions in the alphabet (wrapping z to a), keeping the result lowercase`,
      );
    } else {
      const a = ALPHA[r.int(0, 25)]!;
      const b = ALPHA[r.int(0, 25)]!;
      cur = cur.split(a).join(b);
      steps.push(`replace every '${a}' with '${b}'`);
    }
  }
  const numbered = steps.map((t, i) => `${i + 1}) ${t}`).join("; ");
  return {
    family: "strings",
    prompt: `Start with the string "${s}". Apply these steps in order: ${numbered}. Reply with only the final string.`,
    reference: cur,
    grader: exact(cur),
  };
}

function units(r: Rng, d: number): Generated {
  if (d === 1) {
    const m = r.int(2, 9) * 100;
    return { family: "units", prompt: `Convert ${m} centimeters to meters. Reply with only the number.`, reference: String(m / 100), grader: numeric(m / 100, 0.001) };
  }
  const km = r.int(50, 200 * d) + r.int(0, 9) / 10;
  const hours = r.int(1, d + 1);
  const minutes = r.int(1, 59);
  const mph = km / 1.609344 / (hours + minutes / 60);
  const ref = mph.toFixed(2);
  return {
    family: "units",
    prompt: `A vehicle covers ${km.toFixed(1)} km in ${hours} h ${minutes} min. What is its average speed in miles per hour (1 mile = 1.609344 km)? Reply with only the number rounded to 2 decimal places.`,
    reference: ref,
    grader: numeric(ref, 0.02),
  };
}

function sequence(r: Rng, d: number): Generated {
  if (d === 1) {
    const a = r.int(1, 9);
    const step = r.int(2, 9);
    const value = a + 3 * step;
    return {
      family: "sequence",
      prompt: `A sequence starts at ${a} and each term is ${step} more than the previous one. What is the 4th term? Reply with only the integer.`,
      reference: String(value),
      grader: numeric(value),
    };
  }
  const a1 = BigInt(r.int(1, 9));
  const a2 = BigInt(r.int(10, 30));
  const p = BigInt(r.int(1, 3));
  const q = BigInt(r.int(1, 3));
  const n = d === 1 ? 4 : 8 + 3 * d;
  let prev = a1;
  let cur = a2;
  for (let i = 3; i <= n; i++) {
    const next = p * cur + q * prev + BigInt(i);
    prev = cur;
    cur = next;
  }
  return {
    family: "sequence",
    prompt: `A sequence has a(1) = ${a1}, a(2) = ${a2}, and for n >= 3, a(n) = ${p}*a(n-1) + ${q}*a(n-2) + n. What is a(${n})? Reply with only the integer.`,
    reference: cur.toString(),
    grader: numeric(cur),
  };
}

const GEN: Record<Family, (r: Rng, d: number) => Generated> = { arith, modular, date, strings, units, sequence };

// ------------------------------------------------------------------ public API

export interface GenOptions {
  seed: string;
  count: number;
  difficulty: number; // 1..5
  families?: Family[];
}

export function generateTasks(opts: GenOptions): Task[] {
  const r = new Rng(opts.seed);
  const fams = opts.families ?? FAMILIES;
  const tasks: Task[] = [];
  for (let i = 0; i < opts.count; i++) {
    const g = GEN[fams[i % fams.length]!](r, opts.difficulty);
    tasks.push({
      index: i,
      family: g.family,
      difficulty: opts.difficulty,
      prompt: g.prompt,
      grader: g.grader,
      reference: g.reference,
    });
  }
  return tasks;
}

/** What a junk seller ships: prompts that cannot be answered from their own text. */
export function generateJunkTasks(opts: GenOptions): Task[] {
  const r = new Rng(opts.seed);
  const tasks: Task[] = [];
  for (let i = 0; i < opts.count; i++) {
    const secret = r.int(1, 1_000_000);
    tasks.push({
      index: i,
      family: "arith",
      difficulty: opts.difficulty,
      prompt: `I am thinking of an integer between 1 and 1000000. What integer am I thinking of? Reply with only the integer.`,
      grader: numeric(secret),
      reference: String(secret),
    });
  }
  return tasks;
}

export const UNANSWERABLE = /thinking of|guess (the|my)|what (integer|number) am i/i;
