/**
 * Hybrid encryption with libsodium.
 *
 *   K       = 32 random bytes
 *   ct      = crypto_secretbox_easy(bundleBytes, nonce, K)         (XSalsa20-Poly1305)
 *   sealedK = crypto_box_seal(K, recipientX25519PubKey)            (anonymous sender, 48-byte overhead)
 *   wire    = nonce(24) || sealedK(80) || ct
 *
 * Sealed boxes need no sender key, which is exactly right here: the seller only has the buyer's
 * 32-byte public key from the BountyCreated event. The same sealing primitive lets a buyer hand
 * K to the arbitrator (ClaimsFailed dispute) without publishing the bundle.
 */
import _sodium from "libsodium-wrappers";
import { bytesToHex, hexToBytes, type Hex } from "viem";

export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
export const SEAL_OVERHEAD = 48; // ephemeral pk (32) + MAC (16)
export const SEALED_KEY_BYTES = KEY_BYTES + SEAL_OVERHEAD; // 80

export async function sodium() {
  await _sodium.ready;
  return _sodium;
}

export interface KeyPairHex {
  publicKey: Hex; // 32 bytes, goes on-chain
  secretKey: Hex; // 32 bytes, stays local
}

export async function generateKeyPair(): Promise<KeyPairHex> {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: bytesToHex(kp.publicKey), secretKey: bytesToHex(kp.privateKey) };
}

export async function encryptBundle(plaintext: Uint8Array, recipientPubKey: Hex): Promise<{ ciphertext: Uint8Array; key: Uint8Array }> {
  const s = await sodium();
  const key = s.randombytes_buf(KEY_BYTES);
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const ct = s.crypto_secretbox_easy(plaintext, nonce, key);
  const sealed = s.crypto_box_seal(key, hexToBytes(recipientPubKey));
  if (sealed.length !== SEALED_KEY_BYTES) throw new Error("unexpected sealed key length");
  const out = new Uint8Array(NONCE_BYTES + SEALED_KEY_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  out.set(ct, NONCE_BYTES + SEALED_KEY_BYTES);
  return { ciphertext: out, key };
}

function split(ciphertext: Uint8Array) {
  if (ciphertext.length < NONCE_BYTES + SEALED_KEY_BYTES + 16) throw new Error("ciphertext too short");
  return {
    nonce: ciphertext.subarray(0, NONCE_BYTES),
    sealedKey: ciphertext.subarray(NONCE_BYTES, NONCE_BYTES + SEALED_KEY_BYTES),
    ct: ciphertext.subarray(NONCE_BYTES + SEALED_KEY_BYTES),
  };
}

/** Recipient path: open the sealed key with our X25519 keypair, then the box. Returns plaintext and K. */
export async function decryptBundle(ciphertext: Uint8Array, kp: KeyPairHex): Promise<{ plaintext: Uint8Array; key: Uint8Array }> {
  const s = await sodium();
  const { nonce, sealedKey, ct } = split(ciphertext);
  const key = s.crypto_box_seal_open(sealedKey, hexToBytes(kp.publicKey), hexToBytes(kp.secretKey));
  const plaintext = s.crypto_secretbox_open_easy(ct, nonce, key);
  return { plaintext, key };
}

/** Third-party path (BadDelivery dispute, arbitrator): decrypt with K obtained out of band. */
export async function decryptWithKey(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const { nonce, ct } = split(ciphertext);
  return s.crypto_secretbox_open_easy(ct, nonce, key);
}

/**
 * Deterministic X25519 keypair from a wallet secret and a context string, so agents never have to
 * store per-bounty keys: seed = BLAKE2b-256(key = walletSecret, msg = context).
 * Contexts are namespaced ("evalbounty/v1/buyer/<chainId>/<contract>/<nonce>") so keys for
 * different chains, contracts and bounties are unrelated.
 */
export async function deriveKeyPair(walletSecret: Hex, context: string): Promise<KeyPairHex> {
  const s = await sodium();
  const seed = s.crypto_generichash(32, s.from_string(context), hexToBytes(walletSecret));
  const kp = s.crypto_box_seed_keypair(seed);
  return { publicKey: bytesToHex(kp.publicKey), secretKey: bytesToHex(kp.privateKey) };
}

/** 32 deterministic bytes for a context (e.g. a bundle salt), as hex. */
export async function deriveBytes32(walletSecret: Hex, context: string): Promise<Hex> {
  const s = await sodium();
  return bytesToHex(s.crypto_generichash(32, s.from_string(context), hexToBytes(walletSecret)));
}

/** X25519 public key for a secret key; used to bind published evidence to the on-chain buyerPubKey. */
export async function publicKeyFromSecret(secretKey: Hex): Promise<Hex> {
  const s = await sodium();
  return bytesToHex(s.crypto_scalarmult_base(hexToBytes(secretKey)));
}

export async function sealKeyTo(key: Uint8Array, recipientPubKey: Hex): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_box_seal(key, hexToBytes(recipientPubKey));
}

export async function openSealedKey(sealed: Uint8Array, kp: KeyPairHex): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_box_seal_open(sealed, hexToBytes(kp.publicKey), hexToBytes(kp.secretKey));
}
