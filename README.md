# EvalBounty — a Black Box Bazaar for AI evaluations

**Live app:** `<DASHBOARD_URL>` (Vercel) · **Contract (Sepolia):** [`<EVALBOUNTY_ADDRESS>`](https://sepolia.etherscan.io/address/<EVALBOUNTY_ADDRESS>) · **Arbitrator:** [`<ARBITRATOR_ADDRESS>`](https://sepolia.etherscan.io/address/<ARBITRATOR_ADDRESS>) · **Video:** `<VIDEO_URL>`

Autonomous agents buy and sell **fresh evaluation tasks for AI models** on Ethereum Sepolia. The buyer cannot look at the tasks before paying, because looking is exactly what destroys their value.

## 1. The vertical: fresh evals for AI labs

Labs and deployers pay for hard, unseen benchmark tasks. The moment a task is visible it can leak into training data (contamination), so **"can't inspect before paying" is not a stylistic constraint here, it is the product.** The participants are eval/environment builders (sellers) and labs or model deployers (buyers). The evidence a buyer actually cares about is reproducible: *"a pinned weak model scores ≤ X, a pinned strong model scores ≥ Y, a trivial policy scores ≤ Z"*. The failure modes are equally concrete: tasks that are hard because they are nonsense, answer keys that are wrong, graders that accept anything, non-deterministic scores, and resale after purchase.

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

Reputation counters (commits, rejected samples, abandoned commits, deliveries, timeouts, settlements, disputes won/lost, volume) accrue on-chain per address and are shown on the dashboard.

## 3. Trust assumptions

- **The arbitrator is a single bonded party** (a `CentralizedArbitrator` implementing Kleros' ERC-792 interface). It only touches funds during a dispute; a missed ruling deadline splits the reward 50/50 and returns bonds. Production would plug in a court, a committee, or TEE-attested reruns through the same interface.
- **The model provider is a faithful oracle** for the pinned snapshot and sees the prompts. Reruns are noisy, so claims are bands with a tolerance the buyer sets ≥ 2·SE (Miller, *Adding Error Bars to Evals*, 2024). The demo uses a deterministic mock provider so results reproduce exactly; `MODEL_PROVIDER=anthropic|openai` switches to real models.
- **`blockhash` is an unbiased source of randomness at demo stakes.** A block proposer can bias it by one bit; at higher stakes use a VRF. This is also why the contract lives on Sepolia L1: Arbitrum documents its blockhash as "cryptographically insecure, pseudo-random" and returns a constant for `prevrandao`.
- **Buyers can resell after purchase.** Exclusivity is a contract term backed by reputation, not cryptography.

## 4. Biggest design decision

**The buyer declares a machine-checkable definition of value *before* disclosure, and the market only enforces that definition.** Difficulty on pinned models is verifiable by rerunning; whether tasks are meaningful is *sampled* (commit → blockhash-chosen reveal → Merkle proofs, so a bundle with junk fraction *f* survives a *k*-sample only with probability (1−f)^k); secrecy after sale is reputational. Everything the contract enforces, it can actually check; everything it cannot check is either sampled or priced (bonds, penalties, reputation). We deliberately did not try to verify "usefulness" on-chain or with ZK: the predicate "model X scores Y" has no circuit, so we use optimistic verification in the spirit of FairSwap (cheap happy path, reruns only on dispute).

## 5. One important limitation

**The contract enforces delivery and whether the listed difficulty claims hold, not whether the tasks are useful beyond the sampled ones or stay secret after sale.** A seller can satisfy every claim with tasks that are hard but pointless; the random sample makes that expensive, not impossible.

## Run it

```bash
brew install foundry            # or foundryup
pnpm install && git submodule update --init --recursive
forge test --root contracts     # 33 tests: lifecycle, timeouts, disputes, reentrancy, fuzz, TS↔Solidity fixtures
pnpm --filter agents test       # vitest: canonical bytes, graders, Merkle, crypto, generators, verification
pnpm --filter agents e2e        # fresh anvil → happy path, junk seller rejected, claims dispute, bad delivery dispute
```

Sepolia: `./scripts/set-keys.sh` puts any keys into `agents/.env` with hidden input (only an Etherscan key is worth adding; the mock model provider needs none), fund the deployer, then `./scripts/go-live.sh --demo` deploys, verifies the source, runs the four stories and fills in the addresses below. For live agents instead of the scripted demo, run `pnpm --filter agents arbiter`, `seller`, `buyer` in three terminals.

Dashboard hosting: `dashboard/` is a static site that reads only contract events through a public RPC. `vercel.json` serves it with no build step, so `npx vercel --prod` from the repo root (after `npx vercel login`) publishes it; importing the GitHub repo in the Vercel dashboard works the same way and redeploys on push. `.github/workflows/pages.yml` is an equivalent GitHub Pages deployment if preferred.

## What is reused, and what parallels exist

OpenZeppelin `MerkleProof` + `@openzeppelin/merkle-tree` (leaf format `keccak256(bytes.concat(keccak256(abi.encode(index, keccak256(task)))))`), `Ownable`, `ReentrancyGuard`; libsodium `crypto_secretbox` + `crypto_box_seal` for hybrid encryption; RFC 8785 canonical JSON so all parties hash identical bytes; viem + Foundry. The lifecycle parallels ERC-8183 (*Agentic Commerce*: client funds → provider submits → evaluator completes/rejects → expiry) and disputes speak ERC-792/ERC-1497 (Kleros). ERC-8004 identity/reputation registries exist on Sepolia and could hold the reputation counters; here they stay in the market contract to keep the trust surface small.

## Layout

`contracts/` Foundry (EvalBounty, CentralizedArbitrator, tests) · `agents/` TypeScript buyer/seller/arbiter + libs + e2e · `dashboard/` static GitHub Pages app · `CLAUDE.md` architecture notes.
