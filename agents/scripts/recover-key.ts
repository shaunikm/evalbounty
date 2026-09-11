// Prove a bounty's decryption key can be re-derived from the chain alone (no local state).
//   pnpm --filter agents recover-key 9
import { keyPairForBounty } from "../src/buyer.js";
import { env, evalBounty, log, short, wallet } from "../src/lib/chain.js";
import { publicKeyFromSecret } from "../src/lib/crypto.js";

const id = BigInt(process.argv.filter((a) => a !== "--")[2] ?? "0");
const w = wallet(env.key("BUYER_KEY"));
const b = await evalBounty().read.getBounty([id]);
const kp = await keyPairForBounty(w, id);
const ok = kp.publicKey.toLowerCase() === b.buyerPubKey.toLowerCase() && (await publicKeyFromSecret(kp.secretKey)).toLowerCase() === b.buyerPubKey.toLowerCase();
log("recover", `bounty #${id}: on-chain buyerPubKey ${short(b.buyerPubKey)}, derived ${short(kp.publicKey)} -> ${ok ? "MATCH (recoverable without any stored state)" : "MISMATCH"}`);
process.exit(ok ? 0 : 1);
