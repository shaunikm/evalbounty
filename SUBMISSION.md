# Submission checklist and video script

Deadline: **Thursday 2026-09-11, 2:00 PM** via the B@B Google Form (link in the take-home doc).

## Checklist

- [x] Contracts deployed on Sepolia: EvalBounty `0x6b7f34fa4229aa9545b08c47d187415505c0e7a8`, CentralizedArbitrator `0x5d16caa1e9789a996839aa44a4167b574b887653` (block 11679290), agents funded
- [x] Source verified on Etherscan, Blockscout and Sourcify (`./scripts/verify-sepolia.sh`)
- [x] Keys entered with `./scripts/set-keys.sh`; demo runs on OpenAI `gpt-4.1-nano-2025-04-14` vs `gpt-5-nano-2025-08-07`
- [x] `pnpm --filter agents demo` on Sepolia, all four stories passed with real models (bounties #1 happy → Settled, #2 junk rejected then refilled → Settled, #3 easy → ClaimsFailed → Refunded, #4 garbage → BadDelivery → Refunded). Bounty #0 is a bonus story: a buyer disputed with a key that did not bind to the bounty, and the arbiter ruled for the seller, so the dashboard shows "Disputed → seller wins → Settled" there. Re-run `pnpm --filter agents demo --story=happy` live while recording if you want fresh transactions on camera (about 6 minutes).
- [ ] **Vercel** (your login is required, one time):
  ```bash
  npx vercel login
  ```
  ```bash
  npx vercel --prod
  ```
  When asked for a project name, pick something unique like `evalbounty-bab` (`technical-interview.vercel.app` is taken by
  someone else). The public URL is `https://<project>.vercel.app`. If it shows a Vercel login page, open the project on
  vercel.com → Settings → Deployment Protection and switch Vercel Authentication off. Re-run `npx vercel --prod` after any
  dashboard change or contract redeploy (config.js is committed and served with no-cache).
- [ ] Paste the Vercel URL into README.md (`<DASHBOARD_URL>`) and the form
- [ ] `git push`, make the repo public (GitHub → Settings → General → Danger Zone → Change visibility) — tell Claude to do it, or do it yourself
- [ ] Record the video (≤ 5 min), upload (YouTube unlisted / Drive), paste URL into README.md (`<VIDEO_URL>`)
- [ ] Submit: repo URL, dashboard URL, contract address + Etherscan link, video URL

## Video shot list (target 4:30)

Run `pnpm --filter agents demo` in one terminal and keep the dashboard open in a browser; narrate over it.

| t | Show | Say |
|---|---|---|
| 0:00 | Dashboard hero | "EvalBounty is a market for fresh AI evaluation tasks. The buyer can't look before paying because looking is contamination, so the market has to enforce value without disclosure." |
| 0:30 | Terminal: `createBounty` tx, dashboard row appears Open | "The buyer agent declares value up front: 30 tasks, reveal 4, a weak model must score ≤ 35 %, a strong one ≥ 65 %, a trivial policy ≤ 5 %, all on pinned model ids with committed run params. That's checkable by anyone with the bundle." |
| 1:00 | Seller log: measure → tune → commit | "The seller assembles 30 real evaluation items, here from BIG-Bench Hard and GSM8K, and measures them on the two pinned models: gpt-4.1-nano without reasoning lands around 30 %, the reasoning gpt-5-nano above 90 %. That's inside the band, so it commits a Merkle root plus a bond of half the reward. If the first mix were too easy it would swap in harder subtasks and re-measure." |
| 1:30 | Seller log: `blockhash(n) picked tasks [...]`; dashboard: revealed sample with source ids like `bbh/date_understanding/17` | "The next block's hash picks which 4 tasks are shown. The seller committed before that hash existed, so it can't cherry-pick. Each revealed task carries its provenance. A 30 %-junk bundle survives this 24 % of the time." |
| 2:00 | Buyer log: objective checks, `strong model solved 4/4`, approve | "The buyer checks the sample is well-posed and that the strong model can actually solve some of it, then approves." |
| 2:20 | Seller: encrypt + deliver; Buyer: decrypt, keccak matches, root matches, rerun, accept; dashboard: Settled, reputation updates | "Delivery is encrypted to a per-bounty key and lives in the event log. The buyer decrypts, verifies it is exactly the committed bundle, re-runs all three claims, and accepts. Settlement is a pull-payment with a 2 % fee." |
| 3:05 | Story 2: junk seller rejected, bounty reopens, honest seller fills it | "A junk seller shipping unanswerable prompts: the random sample exposes it, the buyer walks away, the seller gets a reputation mark, the bounty reopens." |
| 3:40 | Story 3: easy seller → ClaimsFailed → arbiter reruns → Refunded, bond slashed | "A subtler cheat: real, well-posed items, but from the subtasks the weak model already solves (boolean expressions, formal fallacies), with fake numbers attached. The buyer's rerun catches it; it disputes through an ERC-792 arbitrator that reruns privately and rules; the seller's bond is slashed." |
| 4:10 | Story 4 (optional): garbage ciphertext → BadDelivery → Refunded | "And a plain bad delivery is provable by anyone." |
| 4:30 | Etherscan verified source; README limitation | "Contract and arbitrator are verified on Sepolia. The limitation, out loud: the contract enforces delivery and the listed claims, not usefulness beyond the sample or secrecy after sale." |

## Interview answers to have ready

- **"I can sell 100 unanswerable questions, satisfy every claim, and win every dispute."** Unanswerable tasks fail the strong-model floor (nobody scores 65 % on them), so they don't satisfy the claims; the random sample also catches them before purchase. What survives is "hard but pointless" tasks that a model can still solve, and that is the stated limitation.
- **Why not verify on-chain / with ZK?** The predicate is "model X scores Y", which no contract or circuit evaluates. Optimistic verification: cheap happy path, reruns only on dispute (FairSwap's philosophy).
- **Nondeterminism?** Run params are committed; claims are bands with tolerance ≥ 2·SE (Miller 2024); arbiter reruns with the same params and rule.
- **Arbiter trust?** Single, bonded, declared, behind the ERC-792 interface; a missed ruling deadline splits funds so it can't lock them. Production: Kleros court, committee, or TEE-attested reruns.
- **Why blockhash and why L1?** The sample must be unknown at commit time and fixed afterwards. blockhash(commit+1) does that with a one-bit proposer bias; Arbitrum's blockhash is documented as insecure and prevrandao is constant there.
- **Grinding?** Commit, peek, walk away, recommit is priced: 10 % of the bond once the sample block has passed, plus a reputation counter.
- **Resale?** Unenforceable for copyable goods; a contract term backed by reputation. The only detector is leakage into the pinned model's scores over time.
- **Why bounties instead of listings?** Buyers declare value before disclosure; sellers compete to satisfy a checkable spec; this is how labs actually procure evals.
- **ERC-8183 / ERC-8004?** Parallels, not dependencies: the lifecycle matches 8183's client → provider → evaluator shape; 8004 registries exist on Sepolia and could hold the reputation counters.
