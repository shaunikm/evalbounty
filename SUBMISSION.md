# Submission checklist and video script

Deadline: **Thursday 2026-09-11, 2:00 PM** via the B@B Google Form (link in the take-home doc).

## Checklist

- [x] Contracts deployed on Sepolia: EvalBounty `0x6b7f34fa4229aa9545b08c47d187415505c0e7a8`, CentralizedArbitrator `0x5d16caa1e9789a996839aa44a4167b574b887653` (block 11679290), agents funded
- [x] Source verified on Etherscan, Blockscout and Sourcify (`./scripts/verify-sepolia.sh`)
- [x] Keys entered with `./scripts/set-keys.sh`; demo runs on OpenAI `gpt-4.1-nano-2025-04-14` vs `gpt-5-nano-2025-08-07`
- [x] `CommitteeArbitrator` deployed on Sepolia at `0x522a3853bae72170be0dca60d141329bc5afd7f0` (sortitioned staked jurors; see ARBITRATION.md) and **the market now points at it**. Bounty #11 went through it live with real models: [dispute](https://sepolia.etherscan.io/tx/0xdcf1df94cd559eb76a96a58595abdd0fd089aeecf7076255f3513be0e0409f68) → [panel drawn](https://sepolia.etherscan.io/tx/0x810eea6b8e4bbc92fa71d6a634ec86c9f90fbd36042208dda3c44c1166a6af02) from the next block's hash → [buyer sealed the bundle key to the three drawn jurors](https://sepolia.etherscan.io/tx/0xc366d9d542c04b0ac27a90344b22daf5c8120bc0bfddfa2931ad6bd52484813a) → three hidden votes, three reveals → [tally](https://sepolia.etherscan.io/tx/0xc582f0a2eb6f8ee8f040cdf2971271ad9f52b180e0e37e7ea5c0dcf91d0614a5) ruled 3/3 for the buyer, seller's bond slashed, no juror slashed, each juror earned 0.0001 ETH. Bounties #12 and #13 (BadDelivery) followed: #12 was finished by one `pnpm --filter agents jurors -- --once` pass (decide, commit, reveal, [tally](https://sepolia.etherscan.io/tx/0x23d2418c337ecc1294e6a93e89151768abf29b9ce292ec240b71c04e1ed4e69e), fee withdrawal) and #13 ran unattended end to end via `pnpm --filter agents demo -- --story=bad` in 287 s ([tally](https://sepolia.etherscan.io/tx/0x30852b322e42cb3beda715a35cb744cad737e86e2853e5dc20665a55c23da520)). The scripted demo seats the panel itself from `JUROR_KEYS`; for loop-mode agents run `pnpm --filter agents jurors` alongside. The happy path never touches the arbitrator.
- [x] `pnpm --filter agents demo` on Sepolia, all four stories passed with real models (bounties #1 happy → Settled, #2 junk rejected then refilled → Settled, #3 easy → ClaimsFailed → Refunded, #4 garbage → BadDelivery → Refunded). Bounty #0 is a bonus story: a buyer disputed with a key that did not bind to the bounty, and the arbiter ruled for the seller, so the dashboard shows "Disputed → seller wins → Settled" there. Bounties #9 and #10 were completed by the loop-mode agents with derived keys; on #10 the buyer rejected the junk seller **on record alone** ("2 of 2 previous samples were rejected") before the honest seller refilled it, which is the reputation moment for the video. Re-run `pnpm --filter agents demo --story=happy` live while recording if you want fresh transactions on camera (about 4 minutes). Wallets were topped up from the Sepolia PoW faucet (≈0.47 ETH across the five agents), enough for dozens of runs.
- [x] **Vercel**: deployed to production at https://evalbounty.vercel.app (project `evalbounty`, no build step, `vercel.json`). Redeploy after dashboard changes or a contract redeploy with `npx vercel --prod` from the repo root.
- [x] Vercel URL written into README.md
- [ ] `git push`, make the repo public (GitHub → Settings → General → Danger Zone → Change visibility) — tell Claude to do it, or do it yourself
- [ ] Record the video (≤ 5 min), upload (YouTube unlisted / Drive), paste URL into README.md (`<VIDEO_URL>`)
- [ ] Submit: repo URL, dashboard URL, contract address + Etherscan link, video URL

## Recording plan (≤ 5 min; the brief says unpolished is fine, "just show everything")

One live happy-path trade (about 3.5 minutes of wall time, two ~50 s model-measurement waits inside it) plus the
failure cases that are already on-chain, narrated over the dashboard during the second wait. Nothing is faked.

**Prep, 15 minutes before (terminal at the repo root)**

```bash
git pull --ff-only
```

Rehearse once; this also proves the RPC, the models and the wallets are healthy and leaves a fresh settled bounty:

```bash
pnpm --filter agents demo -- --story=happy
```

Then: `clear`; terminal font 18–20 pt, window as wide as the screen (log lines are long). Browser tabs, in this order:
1. https://evalbounty.vercel.app (leave it on the top of the page)
2. https://sepolia.etherscan.io/address/0x6b7f34fa4229aa9545b08c47d187415505c0e7a8#events
3. https://github.com/shaunikm/evalbounty (README; make the repo public first)

Do **not** run `junk`, `easy`, `bad` or `committee` live: they take 4.5–10 minutes. They are on-chain as #10, #7/#8 and #11–#13.

**The take** (Cmd+Shift+5 → Record Entire Screen, microphone on; ≈ 410 spoken words ≈ 4:30)

| t | Do | Say |
|---|---|---|
| 0:00 | Dashboard, top of page | "EvalBounty is a marketplace where AI agents buy and sell evaluation tasks for AI models. The buyer can't look before paying, because a benchmark loses its value the moment it's seen. Everything here is a live contract on Ethereum Sepolia; this page only reads the chain." |
| 0:20 | Terminal: `pnpm --filter agents demo -- --story=happy` | "Three autonomous agents: a buyer, a seller and an arbitrator. I'm starting a live trade now." |
| 0:30 | Log: `posting bounty… band weak(gpt-4.1-nano) ≤ 35% strong(gpt-5-nano) ≥ 65%`, `createBounty` tx; dashboard row appears **Open** | "The buyer declares value up front: thirty tasks, reveal four, a weak model must score under 35 percent, a strong reasoning model above 65. Anyone holding the bundle can check that. The reward goes into escrow in the contract." |
| 0:50 | Log: seller `measuring 30/30 tasks…` (≈ 50 s) | "The seller assembles thirty real items from BIG-Bench Hard and GSM8K and measures them on both pinned models before committing. Nobody has seen anything yet. Why this vertical: labs need fresh, uncontaminated tests, and eval builders need a way to sell them without showing them. That is exactly the black-box problem." |
| 1:10 | Log: `commit` tx | "It commits a Merkle root of the tasks, a hash of the whole bundle, and posts a bond of half the reward." |
| 1:30 | Log: `blockhash(N) = 0x… picked tasks […] — I had no say in this`, `revealSample` tx; dashboard: click the row → revealed sample | "The hash of the next block picks which four tasks get revealed. The seller committed before that hash existed, so it cannot cherry-pick. Here they are on the dashboard, each with its provenance." |
| 2:00 | Log: buyer `on-chain record: …`, `strong model solved 4/4`, `approveSample` tx | "The buyer checks the seller's on-chain reputation first, then that the sample is well-posed and the strong model actually solves it. Approve." |
| 2:20 | Log: `encrypting … to buyer key`, `deliver` tx | "Delivery is the bundle encrypted to a key only this buyer has, posted in the event log." |
| 2:30 | Buyer `measuring 30/30…` (≈ 50 s) → dashboard: click **#10**, then **#7**, then **#11** | "While the buyer reruns all thirty tasks, the failure cases, already on chain. Bounty 10: a junk seller with two prior rejections; the buyer rejected it on record alone, without a model call. Bounty 7: a seller shipped too-easy tasks and lied about the numbers; the buyer's rerun caught it, the arbiter reran privately and the bond was slashed. Bounty 11: the same fraud, judged by a staked committee: the next block's hash drew three jurors, the buyer handed them the key, they voted blind, unanimous for the buyer." |
| 3:20 | Terminal: `decrypted…`, `keccak matches`, `Merkle root matches`, `measured weak … strong …`, `all three claims hold → accepting`, `accept` tx | "Back live: the buyer decrypted, proved it's exactly the committed bundle, reran everything, and the claims hold. It accepts; the contract pays the seller minus a two percent fee." |
| 3:40 | Dashboard: row turns **Settled**; Reputation tab | "Settled. Reputation counters update on chain." |
| 3:55 | Etherscan tab: Events, then Contract (green check) | "Every step is a transaction on this verified contract." |
| 4:10 | README, limitation paragraph | "The limitation, out loud: the contract enforces delivery and whether the listed claims hold. It does not prove the tasks are useful beyond the sample, or that they stay secret after sale. That trust still rests on reputation. Thanks." |

**If the live run stalls** (RPC hiccup, a slow block): keep recording and talking over the dashboard; #5, #6 and #9 are the
same happy path already settled. If it recovers, cut back to the terminal. If the recording runs past 5:00, trim the two
measurement waits in QuickTime (Edit → Trim) rather than re-recording.

**After**: upload to YouTube as *Unlisted* (or Drive, anyone with the link), paste the URL over `<VIDEO_URL>` in README.md,
commit and push, submit the form.

If the bundle default moves to 100 tasks, each measurement wait grows to ~70–80 s and the live take runs ~4:15: start the
command about 30 s before pressing record, or trim the waits.

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
