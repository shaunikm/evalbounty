import { describe, expect, it } from "vitest";
import { assessSellerRecord, type SellerRecord } from "../src/buyer.js";

const rec = (o: Partial<SellerRecord>): SellerRecord => ({ commits: 1, samplesRejected: 0, commitsAbandoned: 0, delivered: 0, deliveryTimeouts: 0, settled: 0, disputesWon: 0, disputesLost: 0, volumeWei: 0n, ...o });

describe("buyer reputation policy", () => {
  it("a fresh address is judged on its sample alone", () => {
    expect(assessSellerRecord(rec({ commits: 1 })).ok).toBe(true);
  });
  it("a seller whose samples keep getting rejected is turned away on record", () => {
    // third commit after two rejections
    const r = assessSellerRecord(rec({ commits: 3, samplesRejected: 2 }));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/2 of 2 previous samples/);
  });
  it("more lost disputes than settled trades is disqualifying; the reverse is not", () => {
    expect(assessSellerRecord(rec({ commits: 5, settled: 2, disputesLost: 3 })).ok).toBe(false);
    expect(assessSellerRecord(rec({ commits: 10, settled: 6, disputesLost: 4 })).ok).toBe(true); // the demo's own seller
  });
  it("repeated missed deliveries are disqualifying", () => {
    expect(assessSellerRecord(rec({ commits: 4, deliveryTimeouts: 2 })).ok).toBe(false);
  });
});
