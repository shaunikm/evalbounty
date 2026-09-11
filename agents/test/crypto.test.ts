import { describe, expect, it } from "vitest";
import { decryptBundle, decryptWithKey, encryptBundle, generateKeyPair, openSealedKey, publicKeyFromSecret, sealKeyTo, NONCE_BYTES, SEALED_KEY_BYTES } from "../src/lib/crypto.js";

describe("hybrid encryption", () => {
  it("round-trips to the recipient and to a third party holding K", async () => {
    const buyer = await generateKeyPair();
    const plaintext = new TextEncoder().encode(JSON.stringify({ hello: "world", n: 42 }));
    const { ciphertext, key } = await encryptBundle(plaintext, buyer.publicKey);
    expect(ciphertext.length).toBe(NONCE_BYTES + SEALED_KEY_BYTES + plaintext.length + 16);
    const { plaintext: pt, key: k2 } = await decryptBundle(ciphertext, buyer);
    expect(Buffer.from(pt)).toEqual(Buffer.from(plaintext));
    expect(Buffer.from(k2)).toEqual(Buffer.from(key));
    expect(Buffer.from(await decryptWithKey(ciphertext, key))).toEqual(Buffer.from(plaintext));
  });
  it("fails for the wrong recipient or a tampered byte", async () => {
    const buyer = await generateKeyPair();
    const other = await generateKeyPair();
    const { ciphertext } = await encryptBundle(new TextEncoder().encode("secret"), buyer.publicKey);
    await expect(decryptBundle(ciphertext, other)).rejects.toThrow();
    const tampered = new Uint8Array(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptBundle(tampered, buyer)).rejects.toThrow();
  });
  it("seals K to the arbitrator without revealing it", async () => {
    const arbiter = await generateKeyPair();
    const key = new Uint8Array(32).fill(7);
    const sealed = await sealKeyTo(key, arbiter.publicKey);
    expect(sealed.length).toBe(SEALED_KEY_BYTES);
    expect(Buffer.from(await openSealedKey(sealed, arbiter))).toEqual(Buffer.from(key));
  });
  it("derives the public key from the secret (binds dispute evidence to the on-chain key)", async () => {
    const kp = await generateKeyPair();
    const other = await generateKeyPair();
    expect((await publicKeyFromSecret(kp.secretKey)).toLowerCase()).toBe(kp.publicKey.toLowerCase());
    expect((await publicKeyFromSecret(other.secretKey)).toLowerCase()).not.toBe(kp.publicKey.toLowerCase());
  });
});
