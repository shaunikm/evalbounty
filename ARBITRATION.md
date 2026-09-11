# Arbitration: threat model, the sortitioned staked committee, and what it costs to corrupt

EvalBounty settles most trades without any arbitrator: the buyer reruns the claims and accepts. An
arbitrator is only consulted when the buyer disputes. This document is about what happens then, why
the first version was weak, what replaced it, and the economic argument behind it.

## 1. The vulnerability, stated precisely

The first arbitrator, `CentralizedArbitrator`, is a single key that the market owner names. Two
failures follow, and fixing one without the other leaves the hole open:

1. **A party can influence who judges.** Not by becoming the arbitrator through the contract
   (`giveRuling` is owner-only), but by *being* that key, knowing whose key it is, or knowing them.
   A buyer who controls the arbitrator wins every dispute and takes the seller's bond each time.
2. **The judge has nothing at risk.** The arbitrator collects a fee and stakes nothing. A false
   ruling costs it nothing; appeals are unsupported.

The README originally called this arbitrator "bonded". It was not. That wording is fixed.

## 2. Why cryptography cannot replace the judge for closed models

"Just prove the inference was correct" fails the same way for every technique when the pinned
yardsticks are API models (`gpt-4.1-nano`, `gpt-5-nano` in the demo):

| Approach | Needs | With closed API models |
|---|---|---|
| zkML (EZKL, zkLLM) | model weights to arithmetize | no weights |
| opML (Ora) — bisect a fraud proof to one disputed instruction | weights to replay execution | no weights |
| TEE attestation | hosting the model inside your enclave | the vendor hosts it |

A computation that ran on someone else's server with secrets you do not have is unverifiable by
construction. Replication by parties who have something to lose is the only option, and the design
question is how to make replication honest.

The model choice is a dial the buyer already controls. A bounty that pins **open-weight** models
unlocks all three columns; opML runs fraud proofs for 7B-class models on ordinary hardware and
zk-opML proves only the disputed step. The same ERC-792 interface would carry a cryptographic
arbitrator for those bounties. *A committee for closed models, cryptography for open ones, one
interface.*

## 3. The design: `CommitteeArbitrator`

Implemented in [contracts/src/CommitteeArbitrator.sol](contracts/src/CommitteeArbitrator.sol),
15 Foundry tests in `contracts/test/CommitteeArbitrator.t.sol`, juror agent in
[agents/src/juror.ts](agents/src/juror.ts), exercised end to end by the `committee` story in the anvil
regression. `EvalBounty.sol` is untouched: it speaks ERC-792, so the committee is a second contract
and `setArbitrator(committee)` switches a live market in one owner call. Bounties already in dispute
keep the arbitrator pinned at dispute time.

### 3.1 Sortition by future blockhash (kills failure 1)

```
panel_i = weightedPick(stakedPool, keccak256(blockhash(disputeBlock + 1), disputeId, i))
```

The same primitive the market uses to choose which tasks a seller must reveal. Neither party nor
the owner chooses the panel, and nobody knows it when the dispute is created. Collusion stops being a
relationship arranged in advance and becomes a bribe placed after the fact against people you did not
pick. Jurors are drawn without replacement, weighted by stake; the draw is deterministic and anyone
may execute it once the block exists (`drawPanel`), with a re-roll if the hash expires.

### 3.2 Stake and coherence (kills failure 2)

Jurors stake to become eligible. After the reveal, a vote that reaches two thirds of the panel is
the ruling; jurors who voted otherwise, or did not reveal, lose `slashBps` of their stake, and the fee
plus the slashed stake is shared by the coherent jurors. This is Kleros's coherence rule, but our
Schelling point is stronger than Kleros's: the predicate is *reproducible*. A juror does not guess
what other humans will find fair; it reruns a specified procedure with pinned models, pinned run
params and a pinned grader, and the honest vote is simply the result.

### 3.3 Commit–reveal

Votes are committed as `keccak256(disputeId, vote, salt, juror)` and revealed after the commit window
(or as soon as every juror has committed). A bribed juror cannot prove how it voted before the
reveal, and jurors cannot copy each other.

### 3.4 The no-slash zone (nondeterminism)

LLM inference is near-deterministic, not deterministic: at temperature 0 the vast majority of tokens
match across runs, but floating-point noise from batch composition and hardware changes a few. Three
consequences shape the mechanism:

- Jurors vote on the **verdict** ("do the claims hold?"), never on the exact score.
- A bundle whose true score sits on the band edge would split honest jurors, and slashing the
  minority would punish honesty. So: if **no vote reaches two thirds**, the ruling is `0`, nobody is
  slashed, and everyone who revealed shares the fee. `0` is ERC-792's "refused to arbitrate"; EvalBounty
  treats it as a 50/50 split with all bonds returned.
- Jurors may **vote 0 deliberately**: the juror agent computes the standard error of its own rerun
  and votes "too close to call" when the deciding margin is within two standard errors of the band
  edge. A coherent supermajority for 0 is a ruling like any other.
- Jurors rerun at **higher precision** than the buyer (`JUROR_RUNS_MULTIPLIER`, default 2×), which
  shrinks the standard error exactly where the mechanism needs it. Disputes are rare; precision there
  is cheap.

### 3.5 Economic sizing

Following UMA's rule that the cost of corruption must exceed the profit from corruption:

```
PfC = reward + sellerBond                         what a corrupt panel can redirect
CoC = ceil(2m/3) · minStake · slashBps            what a bribed supermajority forfeits
securedValue() = CoC / lambda                     lambda = 2 by default
```

The contract exposes `securedValue()`; the buyer agent refuses to post a bounty whose reward plus
bond exceeds it when `BUYER_ENFORCE_SECURITY=1` (on by default in the anvil regression, where stakes
are 1 ETH) and warns otherwise (testnet stakes are tiny). Enforcing it inside `createBounty` needs the
market to know the arbitrator's economics and is the natural v2 change to `EvalBounty`.

### 3.6 Key handoff

Jurors do not exist until sortition, so a ClaimsFailed buyer cannot seal the bundle key in the dispute
evidence. Flow: `dispute → drawPanel → buyer.submitKeys(disputeId, bountyId, K sealed to each juror's
registered X25519 key) → jurors rerun → commit → reveal → execute`. `submitKeys` checks the caller is
the bounty's buyer and that the bounty references this dispute. If the buyer never hands over the
key, jurors cannot substantiate the claim and vote for the seller: a dispute the buyer will not
substantiate is a dispute the buyer loses. BadDelivery disputes need no handoff; the evidence is
public.

## 4. What is deliberately not built

- **Appeals with escalating panels** (Kleros doubles the panel each round, loser pays). The
  interface reports appeals as unsupported. Losing parties are protected by the no-slash zone and the
  50/50 fallback, and the reputation counters record outcomes.
- **On-chain PfC check in `createBounty`** (needs a market redeploy; agent-enforced today).
- **ERC-8004 Validation Registry** as the public record of rulings (`validationRequest` /
  `validationResponse`) so other protocols can read arbitration history. The registries exist on
  Sepolia; wiring them is additive.
- **Sybil resistance for jurors.** Stake is the only cost of a juror identity; one operator can run
  the whole panel, as the demo does for convenience. Real independence needs a large, diverse pool,
  which is an operations problem, not a contract one.

## 5. Interview answers

- *"Can't the buyer be the arbiter?"* Not with the committee: the buyer does not pick the panel, the
  chain does, after the dispute exists, from jurors who staked before it existed.
- *"What does a lying juror lose?"* `slashBps` of its stake to the jurors who voted with the truth,
  and nothing if the panel honestly could not agree.
- *"Why not appeals?"* They are the next layer; the split-on-disagreement rule already keeps a
  divided panel from moving money, which is the failure appeals mostly exist to catch.
- *"Why is this still not fully trustless?"* Because the yardsticks are closed models. The design
  makes the judges random and staked; only open-weight yardsticks let cryptography replace them.
