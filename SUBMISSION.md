# Submission checklist and video script

Deadline: **Thursday 2026-09-11, 2:00 PM** via the B@B Google Form (link in the take-home doc).

## Checklist

- [x] Contracts deployed on Sepolia: EvalBounty `0x6b7f34fa4229aa9545b08c47d187415505c0e7a8`, CentralizedArbitrator `0x5d16caa1e9789a996839aa44a4167b574b887653` (block 11679290), agents funded
- [x] Source verified on Etherscan, Blockscout and Sourcify (`./scripts/verify-sepolia.sh`)
- [x] Keys entered with `./scripts/set-keys.sh`; demo runs on OpenAI `gpt-4.1-nano-2025-04-14` vs `gpt-5-nano-2025-08-07`
- [x] `CommitteeArbitrator` deployed on Sepolia at `0x522a3853bae72170be0dca60d141329bc5afd7f0` (sortitioned staked jurors; see ARBITRATION.md). Once the market points at it, disputes need juror agents online: `pnpm --filter agents jurors` (uses `JUROR_KEYS` from `agents/.env`). The happy path never touches the arbitrator.
- [x] `pnpm --filter agents demo` on Sepolia, all four stories passed with real models (bounties #1 happy → Settled, #2 junk rejected then refilled → Settled, #3 easy → ClaimsFailed → Refunded, #4 garbage → BadDelivery → Refunded). Bounty #0 is a bonus story: a buyer disputed with a key that did not bind to the bounty, and the arbiter ruled for the seller, so the dashboard shows "Disputed → seller wins → Settled" there. Bounties #9 and #10 were completed by the loop-mode agents with derived keys; on #10 the buyer rejected the junk seller **on record alone** ("2 of 2 previous samples were rejected") before the honest seller refilled it, which is the reputation moment for the video. Re-run `pnpm --filter agents demo --story=happy` live while recording if you want fresh transactions on camera (about 4 minutes). Wallets hold enough for exactly one such run; for more, top up the buyer and seller from another faucet first.
- [x] **Vercel**: deployed to production at https://evalbounty.vercel.app (project `evalbounty`, no build step, `vercel.json`). Redeploy after dashboard changes or a contract redeploy with `npx vercel --prod` from the repo root.
- [x] Vercel URL written into README.md
- [ ] `git push`, make the repo public (GitHub → Settings → General → Danger Zone → Change visibility) — tell Claude to do it, or do it yourself
- [ ] Record the video (≤ 5 min), upload (YouTube unlisted / Drive), paste URL into README.md (`<VIDEO_URL>`)
- [ ] Submit: repo URL, dashboard URL, contract address + Etherscan link, video URL

## Recording plan (≤ 5 min; the brief says unpolished is fine, "just show everything")

The product is agents acting on a chain, so the video shows the agents acting and the chain confirming it. Nothing
needs to be pre-recorded or faked; one live run plus the history already on-chain covers the "complete experience".

**Before you press record**

1. Top up the buyer and seller wallets (`agents/state/addresses.json`) from a faucet if you want a retake; today they hold exactly one live run.
2. Open three things side by side: a terminal in `agents/` with a large font, https://evalbounty.vercel.app, and one Etherscan tab
   on the contract's Events page: https://sepolia.etherscan.io/address/0x6b7f34fa4229aa9545b08c47d187415505c0e7a8#events
3. macOS: Cmd+Shift+5 → record the screen; talk over it. Upload to YouTube as *Unlisted*, paste the link into README.md.

**The take** (times are approximate; cut dead air in editing or just let it run)

| t | Do | Say |
|---|---|---|
| 0:00 | Dashboard, top of page | "EvalBounty is a marketplace where AI agents buy and sell evaluation tasks for AI models. The buyer can't inspect before paying because a benchmark loses its value the moment it's seen. Everything you'll see is a real transaction on Ethereum Sepolia; this page only reads the chain." |
| 0:25 | Terminal: `pnpm --filter agents demo -- --story=happy` | "Three autonomous agents: a buyer, a seller and an arbiter. I'm starting a live trade." |
| 0:35 | Log: `posting bounty… band weak(gpt-4.1-nano) ≤ 35% strong(gpt-5-nano) ≥ 65%`, then `createBounty` tx link; dashboard row appears **Open** | "The buyer defines value up front: 30 tasks, reveal 4, a weak model must score under 35%, a strong reasoning model over 65%. That's checkable by anyone holding the bundle. The reward is now in escrow in the contract." |
| 1:00 | Log: `measuring 30/30 tasks…` then `measured difficulty 3: weak 16.7% strong 91.1%` and `commit` tx | "The seller assembles 30 real items from BIG-Bench Hard and GSM8K, measures them on both pinned models, and commits a Merkle root plus a bond of half the reward. It hasn't shown the buyer anything yet." |
| 1:30 | Log: `blockhash(N) = 0x… picked tasks [..] — I had no say in this`, `revealSample` tx; dashboard: click the row → Revealed sample with source ids | "The next block's hash decides which four tasks get revealed. The seller committed before that hash existed, so it can't cherry-pick. Here they are on the dashboard, each with its provenance." |
| 2:00 | Log: buyer `on-chain record: …`, `strong model solved 4/4`, `approving` | "The buyer first reads the seller's on-chain reputation, then checks the sample is well-posed and that the strong model can actually solve it. Approve." |
| 2:20 | Log: `encrypting … bundle to buyer key`, `deliver` tx; then buyer `decrypted…`, `keccak matches the commitment`, `Merkle root … matches`, `measuring 30/30`, `measured weak 18.9% strong 98.9%`, `all three claims hold → accepting` | "Delivery is encrypted to a key only this buyer holds, posted in the event log. The buyer decrypts, proves it's exactly the committed bundle, reruns all 30 tasks on both models, and the claims hold. It accepts; the contract pays the seller minus a 2% fee." |
| 3:05 | Dashboard: row turns **Settled**; Reputation tab shows counters move | "Settled. Reputation counters update on-chain." |
| 3:15 | Dashboard: click bounty **#10** → timeline | "Now the failure cases, already on-chain. Here a junk seller with two prior rejections committed; the buyer rejected it on its record alone, without spending a model call, and the honest seller refilled the bounty." |
| 3:40 | Dashboard: click bounty **#7** → timeline (ClaimsFailed → Ruling → Refunded) | "Here a seller shipped real but too-easy tasks and lied about the numbers. The buyer's rerun measured the weak model at 61% against a claimed 30%, disputed, and the arbiter reran privately and ruled for the buyer. The seller's bond was slashed." |
| 4:05 | Dashboard: click bounty **#8** (BadDelivery) | "And a plain bad delivery: garbage bytes instead of the bundle. Provable by anyone, ruled for the buyer." |
| 4:20 | Etherscan Events tab, then Contract tab (green check) | "Every step is a transaction on this contract, source verified." |
| 4:35 | README, limitation paragraph | "The limitation, out loud: the contract enforces delivery and whether the listed difficulty claims hold. It does not prove tasks are useful beyond the sample or that they stay secret after sale. Thanks." |

If the live run hits an RPC hiccup, keep recording: the dashboard history (#5, #6, #9) shows the same happy path already settled, and the narration works over it.

## Interview answers to have ready

- **"I can sell 100 unanswerable questions, satisfy every claim, and win every dispute."** Unanswerable tasks fail the strong-model floor (nobody scores 65 % on them), so they don't satisfy the claims; the random sample also catches them before purchase. What survives is "hard but pointless" tasks that a model can still solve, and that is the stated limitation.
- **"Isn't sampling four tasks kind of primitive?"** It is the standard tool when full checking is destructive: Filecoin challenges random pieces of stored data, TrueBit and rollups verify optimistically with disputes, Belenkiy et al. formalised spot-checking with bonds. Revealing a task destroys it, so the sample stays small and the full 30-task rerun happens right after delivery. Smarter upgrades exist and are in the README: verifiable encryption for delivery (a16z's Fair Data Exchange, CCS 2024) and TEE- or zkTLS-attested measurement so a buyer can verify all claims before paying.
- **Why not verify on-chain / with ZK?** The predicate is "model X scores Y", which no contract or circuit evaluates. Optimistic verification: cheap happy path, reruns only on dispute (FairSwap's philosophy).
- **Nondeterminism?** Run params are committed; claims are bands with tolerance ≥ 2·SE (Miller 2024); arbiter reruns with the same params and rule.
- **"The buyer could just be the arbiter."** With `CentralizedArbitrator`, yes, and it stakes nothing; that is why `CommitteeArbitrator` exists: the panel is drawn by the hash of the block after the dispute from jurors who staked beforehand, votes are commit–reveal, jurors who vote against a two-thirds supermajority lose stake, and a divided panel refuses (50/50) instead of slashing honest disagreement. Switching a live market is one owner call because EvalBounty only speaks ERC-792. Cost-of-corruption sizing is `securedValue()`. Cryptographic verification is impossible for closed API models; open-weight yardsticks would allow opML/zkML arbitrators behind the same interface.
- **Arbiter trust?** Single, bonded, declared, behind the ERC-792 interface; a missed ruling deadline splits funds so it can't lock them. Production: Kleros court, committee, or TEE-attested reruns.
- **Why blockhash and why L1?** The sample must be unknown at commit time and fixed afterwards. blockhash(commit+1) does that with a one-bit proposer bias; Arbitrum's blockhash is documented as insecure and prevrandao is constant there.
- **Grinding?** Commit, peek, walk away, recommit is priced: 10 % of the bond once the sample block has passed, plus a reputation counter.
- **Resale?** Unenforceable for copyable goods; a contract term backed by reputation. The only detector is leakage into the pinned model's scores over time.
- **Why bounties instead of listings?** Buyers declare value before disclosure; sellers compete to satisfy a checkable spec; this is how labs actually procure evals.
- **ERC-8183 / ERC-8004?** Parallels, not dependencies: the lifecycle matches 8183's client → provider → evaluator shape; 8004 registries exist on Sepolia and could hold the reputation counters.
