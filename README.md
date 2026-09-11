# EvalBounty — a Black Box Bazaar for AI evaluations

**Live app:** https://evalbounty.vercel.app · **Contract (Sepolia):** [`0x6b7f34fa4229aa9545b08c47d187415505c0e7a8`](https://sepolia.etherscan.io/address/0x6b7f34fa4229aa9545b08c47d187415505c0e7a8) · **Arbitrator (live, committee):** [`0x522A3853bAe72170BE0dCA60D141329bC5AfD7f0`](https://sepolia.etherscan.io/address/0x522A3853bAe72170BE0dCA60D141329bC5AfD7f0) · **Arbitrator (legacy single key, bounties #0–#10):** [`0x5d16caa1e9789a996839aa44a4167b574b887653`](https://sepolia.etherscan.io/address/0x5d16caa1e9789a996839aa44a4167b574b887653) · **Video:** `<VIDEO_URL>`

Autonomous agents buy and sell **fresh evaluation tasks for AI models** on Ethereum Sepolia. The buyer cannot look at the tasks before paying, because looking is exactly what destroys their value.

## 1. The vertical: fresh evals for AI labs

Labs and deployers pay for hard, unseen benchmark tasks. The moment a task is visible it can leak into training data (contamination), so **"can't inspect before paying" is not a stylistic constraint here, it is the product.** The participants are eval/environment builders (sellers) and labs or model deployers (buyers). The evidence a buyer actually cares about is reproducible: *"a pinned weak model scores ≤ X, a pinned strong model scores ≥ Y, a trivial policy scores ≤ Z"*. The failure modes are equally concrete: tasks that are hard because they are nonsense, answer keys that are wrong, graders that accept anything, non-deterministic scores, and resale after purchase.

**What is actually sold.** Bundles are made of real evaluation items with exact-answer graders. The demo seller samples from committed snapshots of two public suites, [BIG-Bench Hard](https://github.com/suzgunmirac/BIG-Bench-Hard) (19 reasoning subtasks such as date understanding, multistep arithmetic, word sorting, tracking shuffled objects; Suzgun et al. 2022, MIT) and [GSM8K](https://github.com/openai/grade-school-math) (grade-school math word problems; Cobbe et al. 2021, MIT), recorded with URLs, hashes and licenses in `agents/data/SOURCES.json`. Every task carries its source id, so a buyer can see provenance. Public items are the contaminated case by definition; a real seller's value is that its items are *not* public, which is exactly what the buyer cannot verify before paying and what the random sample is for. "Difficulty" is a mix of subtasks ordered by measured scores of the pinned models (`pnpm --filter agents calibrate-families`); a synthetic generator remains available with `TASK_SOURCE=synthetic`.

## 2. How a trade works

```
Buyer: createBounty(spec, X25519 pubkey) + reward escrow          spec = domain, N, k, weak/strong model ids,
Seller: commit(merkleRoot, keccak(bundle)) + bond ≥ 50% reward           band in bps, runs, tolerance, runParamsHash
Chain:  sampleBlock = commit block + 1 → blockhash picks k of N indices
Seller: revealSample(k tasks, Merkle proofs)         ← cannot cherry-pick: committed before the hash existed
Buyer:  approveSample / rejectSample                  ← subjective walk-away, never slashes
Seller: deliver(ciphertext)                           ← bundle encrypted to the buyer's key, lives in the event log
Buyer:  decrypt, check keccak == commitment, rebuild root == taskRoot, RERUN the three claims
        accept → seller paid (2% fee)   |   dispute(kind, evidence) + bond → ERC-792 arbitrator reruns → rule
Anyone: finalize() past any deadline (slash / settle / split) so no party can lock funds
```

Reputation counters (commits, rejected samples, abandoned commits, deliveries, timeouts, settlements, disputes won/lost, volume) accrue on-chain per address and are shown on the dashboard. The buyer agent reads a seller's record before spending a single model call on its sample and rejects on record alone when the record is worse than its successes (more disputes lost than trades settled, a majority of past samples rejected, or repeated missed deliveries; thresholds are configurable). Reputation is per address and addresses are free, so a bad seller can rotate; the bond already protects each single trade, and the honest framing is that reputation *lowers the bond a good seller needs over time* rather than keeping bad sellers out. The natural next step is reputation-scaled bonds inside the contract, and ERC-8004's identity and reputation registries are the hook that would make a record portable across markets.

## 3. Trust assumptions

- **Arbitration is pluggable (ERC-792) and comes in two implementations.** `CentralizedArbitrator` is a single key with *no* stake, adequate for a demo and vulnerable to a buyer who controls or knows that key. `CommitteeArbitrator` fixes both halves of that weakness: the panel is drawn from a staked juror pool by the hash of the block after the dispute exists, so nobody picks the judges; votes are commit–reveal; jurors who vote against a two-thirds supermajority lose stake to those who voted with it; if no supermajority forms, the ruling is "refused" (50/50 split) and nobody is slashed, which is how near-deterministic model inference is handled. Switching a live market is one owner call. Full threat model and economics in [ARBITRATION.md](ARBITRATION.md). Either way the arbitrator only touches funds during a dispute, and a missed ruling deadline splits the reward and returns bonds.
- **The model provider is a faithful oracle** for the pinned snapshot and sees the prompts. Reruns are noisy, so claims are bands with a tolerance the buyer sets ≥ 2·SE (Miller, *Adding Error Bars to Evals*, 2024). `MODEL_PROVIDER=mock` is a deterministic keyless provider used by the tests; the Sepolia demo runs `MODEL_PROVIDER=openai` with pinned snapshots `gpt-4.1-nano-2025-04-14` (weak, no reasoning) and `gpt-5-nano-2025-08-07` (strong, reasoning at low effort), the cheapest pair with a real capability gap. Paid providers are wrapped in a per-process call budget (`MODEL_CALL_BUDGET`, default 3000) so no loop or hostile counterparty can drain credits.
- **`blockhash` is an unbiased source of randomness at demo stakes.** A block proposer can bias it by one bit; at higher stakes use a VRF. This is also why the contract lives on Sepolia L1: Arbitrum documents its blockhash as "cryptographically insecure, pseudo-random" and returns a constant for `prevrandao`.
- **Buyers can resell after purchase.** Exclusivity is a contract term backed by reputation, not cryptography.

## 4. Biggest design decision

**The buyer declares a machine-checkable definition of value *before* disclosure, and the market only enforces that definition.** Difficulty on pinned models is verifiable by rerunning; whether tasks are meaningful is *sampled* (commit → blockhash-chosen reveal → Merkle proofs, so a bundle with junk fraction *f* survives a *k*-sample only with probability (1−f)^k); secrecy after sale is reputational. Everything the contract enforces, it can actually check; everything it cannot check is either sampled or priced (bonds, penalties, reputation). We deliberately did not try to verify "usefulness" on-chain or with ZK: the predicate "model X scores Y" has no circuit, so we use optimistic verification in the spirit of FairSwap (cheap happy path, reruns only on dispute).

## 4b. Why the judges can be trusted at all

The buyer cannot pick the arbitrator. With the committee, it cannot even know who the arbitrator will be: the panel is sortitioned by a future block hash from jurors who staked before the dispute existed, each juror reruns the claims at higher precision than the buyer did, and a juror that votes against the reproducible truth loses stake. Cryptographic verification of the model calls themselves is impossible for closed API models (no weights to prove over), which is why the yardstick models a buyer pins are a security parameter: open-weight yardsticks would let an opML or zkML arbitrator take the committee's place behind the same interface. Details, including the cost-of-corruption sizing rule `securedValue()`, are in [ARBITRATION.md](ARBITRATION.md). This ran live on Sepolia for bounty #11: a seller shipped too-easy tasks, the buyer [disputed](https://sepolia.etherscan.io/tx/0xdcf1df94cd559eb76a96a58595abdd0fd089aeecf7076255f3513be0e0409f68), the chain [drew three staked jurors](https://sepolia.etherscan.io/tx/0x810eea6b8e4bbc92fa71d6a634ec86c9f90fbd36042208dda3c44c1166a6af02) from the hash of the next block, the buyer [sealed the bundle key to exactly those three](https://sepolia.etherscan.io/tx/0xc366d9d542c04b0ac27a90344b22daf5c8120bc0bfddfa2931ad6bd52484813a), each reran the 30 tasks on both models, committed a hidden vote, revealed, and the [tally](https://sepolia.etherscan.io/tx/0xc582f0a2eb6f8ee8f040cdf2971271ad9f52b180e0e37e7ea5c0dcf91d0614a5) ruled unanimously for the buyer; the seller's bond went to the buyer, no juror was slashed, and each earned its fee.

## 5. One important limitation

**The contract enforces delivery and whether the listed difficulty claims hold, not whether the tasks are useful beyond the sampled ones or stay secret after sale.** A seller can satisfy every claim with tasks that are hard but pointless; the random sample makes that expensive, not impossible.

## Run it

```bash
brew install foundry            # or foundryup
pnpm install && git submodule update --init --recursive
forge test --root contracts     # 48 tests: lifecycle, timeouts, disputes, reentrancy, fuzz, TS↔Solidity fixtures, committee sortition/voting/slashing
pnpm --filter agents test       # vitest: canonical bytes, graders, Merkle, crypto, generators, verification
pnpm --filter agents e2e        # fresh anvil → happy path, junk seller rejected, claims dispute, bad delivery dispute, committee-arbitrated dispute
```

Sepolia: `./scripts/set-keys.sh` puts any keys into `agents/.env` with hidden input (only an Etherscan key is worth adding; the mock model provider needs none), fund the deployer, then `./scripts/go-live.sh --demo` deploys, verifies the source, runs the five stories and fills in the addresses below. For live agents instead of the scripted demo, run `pnpm --filter agents arbiter`, `seller`, `buyer` in three terminals.

Dashboard hosting: `dashboard/` is a static site that reads only contract events through a public RPC. `vercel.json` serves it with no build step, so `npx vercel --prod` from the repo root (after `npx vercel login`) publishes it; importing the GitHub repo in the Vercel dashboard works the same way and redeploys on push. `.github/workflows/pages.yml` is an equivalent GitHub Pages deployment if preferred.

## Why sampling plus optimistic verification, and what would be smarter

"Just sample four tasks and rerun the rest after paying" sounds rustic. It is the standard architecture for verifying something you cannot check in full or cannot reveal, and each piece has a pedigree: Filecoin's [Proof-of-Spacetime](https://spec.filecoin.io/algorithms/pos/post/) challenges pseudo-random pieces of stored data because checking everything is too expensive; Belenkiy et al. ([*Incentivizing Outsourced Computation*, 2008](https://eprint.iacr.org/2013/156)) formalise spot-checking with rewards and fines against rational cheaters, which is exactly what the bond and reputation counters do; TrueBit and optimistic rollups accept results optimistically and escalate to a dispute only on challenge, which is our accept-or-dispute step; FairSwap (CCS 2018) applies the same idea to selling a digital good. The sample is small because *revealing a task destroys it*: four tasks catch a 30 %-junk bundle 76 % of the time while costing the seller little, and the full 30-task check runs the moment it safely can, after delivery, on the buyer's machine, with the arbiter rerunning on dispute.

Three upgrades are genuinely smarter, in the order I would build them:

1. **Verifiable encryption for delivery.** Tas, Seres, Bonneau, Nikolaenko et al., [*Atomic and Fair Data Exchange via Blockchain*](https://eprint.iacr.org/2024/418) (CCS 2024), make the client pay *if and only if* the revealed key decrypts a ciphertext consistent with the on-chain commitment ("verifiable encryption under committed key"). That would turn our BadDelivery dispute into a cryptographic guarantee and remove the arbiter from delivery integrity entirely.
2. **Attested measurement before payment.** Run the 30-task evaluation inside a trusted execution environment, as [TRUCE](https://arxiv.org/abs/2403.00393) proposes for private benchmarking in confidential VMs, or prove the seller's model-API transcripts with zkTLS ([DECO](https://review.stanfordblockchain.xyz/p/74-cryptography-research-spotlight), [Reclaim](https://blog.reclaimprotocol.org/posts/zk-in-zktls), TLSNotary). Either lets a buyer verify *all* claims before paying without seeing a single task; the trust moves to the TEE vendor or attestor, and the arbiter becomes a fallback.
3. **Reputation-scaled bonds** in the contract (see above).

What is *not* viable: proving model performance in zero knowledge. The pinned models are closed APIs with no accessible weights, and even for open models current systems such as [zkLLM](https://arxiv.org/abs/2404.16109) take on the order of fifteen minutes per inference for a 13B model; ninety inferences per claim is not a payment predicate. Evaluating on-chain is likewise impossible: a contract cannot call a model. Hence optimistic verification with a bonded arbiter today, and (1) and (2) as the production path.

## Configuration (nothing is hard-coded to this deployment)

| Where | Setting | Meaning |
|---|---|---|
| `agents/.env` | `CHAIN` | viem chain name or id (`sepolia`, `anvil`, `baseSepolia`, `11155111`); explorer links come from the chain definition |
| | `RPC_URL`, `EVALBOUNTY_ADDRESS`, `ARBITRATOR_ADDRESS`, `DEPLOY_BLOCK` | written by `deploy-contracts`; point agents at any deployment |
| | `MODEL_PROVIDER` | `auto` (route each model id to its vendor: `claude-*` → Anthropic, `gpt-*`/`o*` → OpenAI, `mock-*` → mock), or `mock` to force the keyless mock |
| | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MODEL_CALL_BUDGET`, `OPENAI_REASONING_EFFORT` | vendor keys, per-process spend cap (default 3000 calls), reasoning effort |
| | `COMMITTEE_ADDRESS`, `JUROR_KEYS`, `JUROR_RUNS_MULTIPLIER`, `BUYER_ENFORCE_SECURITY`, `BUYER_REWARD_ETH` | committee arbitrator, juror wallets (`pnpm --filter agents jurors`), juror rerun precision, refuse bounties the stake cannot secure, demo reward size |
| | `SELLER_DOMAINS`, `BUYER_DOMAIN`, `TASK_SOURCE` | domains a seller serves; the buyer's domain tag; `real` (BBH + GSM8K snapshots) or `synthetic` |
| Dashboard URL | `?contract=0x…&chain=11155111&from=<deployBlock>&rpc=…` | inspect any EvalBounty deployment on any chain; overrides `config.js` |
| Vercel env | `EVALBOUNTY_ADDRESS`, `ARBITRATOR_ADDRESS`, `DEPLOY_BLOCK`, `CHAIN_ID`, `RPC_URL` | `dashboard/build-config.mjs` writes `config.js` at build time when set |

Keys are never stored: the buyer derives each bounty's X25519 key from its wallet key and the creating transaction's nonce (recoverable from the chain), and the arbiter derives its key from its wallet and registers it on the arbitrator contract. The dashboard fetches events incrementally in provider-safe block windows and caches raw logs per (chain, contract) in the browser, so history survives RPC range limits; the chain stays the source of truth. Interoperability rules for third-party agents are in [PROTOCOL.md](PROTOCOL.md).

## What is reused, and what parallels exist

OpenZeppelin `MerkleProof` + `@openzeppelin/merkle-tree` (leaf format `keccak256(bytes.concat(keccak256(abi.encode(index, keccak256(task)))))`), `Ownable`, `ReentrancyGuard`; libsodium `crypto_secretbox` + `crypto_box_seal` for hybrid encryption; RFC 8785 canonical JSON so all parties hash identical bytes; viem + Foundry. The lifecycle parallels ERC-8183 (*Agentic Commerce*: client funds → provider submits → evaluator completes/rejects → expiry) and disputes speak ERC-792/ERC-1497 (Kleros). ERC-8004 identity/reputation registries exist on Sepolia and could hold the reputation counters; here they stay in the market contract to keep the trust surface small.

## Layout

`contracts/` Foundry (EvalBounty, CentralizedArbitrator, CommitteeArbitrator, tests) · `agents/` TypeScript buyer/seller/arbiter + libs + e2e · `dashboard/` static app (Vercel) · `scripts/` set-keys, go-live, verify, check-no-secrets · `CLAUDE.md` architecture notes.

Deployed on Sepolia at block 11679290. Source is verified on [Etherscan](https://sepolia.etherscan.io/address/0x6b7f34fa4229aa9545b08c47d187415505c0e7a8#code) and [Blockscout](https://eth-sepolia.blockscout.com/address/0x6b7f34fa4229aa9545b08c47d187415505c0e7a8?tab=contract).
