# Submission checklist and video script

Deadline: **Thursday 2026-09-11, 2:00 PM** via the B@B Google Form (link in the take-home doc).

## Checklist

- [ ] Deployer funded → `CHAIN=sepolia pnpm --filter agents deploy` (writes addresses into `agents/.env` and `dashboard/config.js`)
- [ ] `./scripts/verify-sepolia.sh` (Sourcify + Blockscout keyless; add `ETHERSCAN_API_KEY=` for the Etherscan "Contract" tab)
- [ ] `pnpm --filter agents demo` once end-to-end on Sepolia (≈ 8–10 min at 12 s blocks) so the dashboard has real history
- [ ] Fill `<EVALBOUNTY_ADDRESS>`, `<ARBITRATOR_ADDRESS>`, `<VIDEO_URL>` in `README.md`
- [ ] Repo public, GitHub Pages enabled (Settings → Pages → Source: GitHub Actions; the `pages` workflow deploys `dashboard/`)
- [ ] Record the video (≤ 5 min, unpolished is fine), upload (YouTube unlisted / Drive), paste URL in README
- [ ] Submit: repo URL, dashboard URL, contract address + Etherscan link, video URL

## Video shot list (target 4:30)

Run `pnpm --filter agents demo` in one terminal and keep the dashboard open in a browser; narrate over it.

| t | Show | Say |
|---|---|---|
| 0:00 | Dashboard hero | "EvalBounty is a market for fresh AI evaluation tasks. The buyer can't look before paying because looking is contamination, so the market has to enforce value without disclosure." |
| 0:30 | Terminal: `createBounty` tx, dashboard row appears Open | "The buyer agent declares value up front: 30 tasks, reveal 4, a weak model must score ≤ 35 %, a strong one ≥ 65 %, a trivial policy ≤ 5 %, all on pinned model ids with committed run params. That's checkable by anyone with the bundle." |
| 1:00 | Seller log: measure → tune → commit | "The seller generates tasks with computed answer keys, measures the band, tunes difficulty until it fits, and commits a Merkle root plus a bond of half the reward." |
| 1:30 | Seller log: `blockhash(n) picked tasks [...]`; dashboard: revealed sample | "The next block's hash picks which 4 tasks are shown. The seller committed before that hash existed, so it can't cherry-pick. A 30 %-junk bundle survives this 24 % of the time." |
| 2:00 | Buyer log: objective checks, `strong model solved 4/4`, approve | "The buyer checks the sample is well-posed and that the strong model can actually solve some of it, then approves." |
| 2:20 | Seller: encrypt + deliver; Buyer: decrypt, keccak matches, root matches, rerun, accept; dashboard: Settled, reputation updates | "Delivery is encrypted to a per-bounty key and lives in the event log. The buyer decrypts, verifies it is exactly the committed bundle, re-runs all three claims, and accepts. Settlement is a pull-payment with a 2 % fee." |
| 3:05 | Story 2: junk seller rejected, bounty reopens, honest seller fills it | "A junk seller shipping unanswerable prompts: the random sample exposes it, the buyer walks away, the seller gets a reputation mark, the bounty reopens." |
| 3:40 | Story 3: easy seller → ClaimsFailed → arbiter reruns → Refunded, bond slashed | "A subtler cheat: well-posed but too-easy tasks with fake numbers. The rerun catches it; the buyer disputes through an ERC-792 arbitrator that reruns privately and rules; the seller's bond is slashed." |
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
