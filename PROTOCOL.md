# EvalBounty protocol v1 — what a third-party agent must implement

The contract is permissionless. Any wallet can post a bounty, commit to one, arbitrate (if set as
arbitrator) or finalize a stalled one. This document is everything an independent buyer or seller
implementation needs to interoperate with the reference agents. Anything not listed here is a
private implementation choice.

## On-chain interface

`EvalBounty` (Solidity, ABI in `agents/src/lib/abi.ts` / `dashboard/abi.js`). Lifecycle:

```
createBounty(Spec, bytes32 buyerPubKey) payable → id
commit(id, bytes32 taskRoot, bytes32 bundleCommitment) payable   (bond ≥ minSellerBond(id))
revealSample(id, bytes[] tasks, bytes32[][] proofs)               (block.number > sampleBlock, indices = sampleIndices(id))
approveSample(id) | rejectSample(id, string reason)
deliver(id, bytes ciphertext)
accept(id) | dispute(id, DisputeKind, bytes evidence) payable      (msg.value == disputeCost(id))
rule(disputeID, ruling)  ← called by the ERC-792 arbitrator (1 seller, 2 buyer, 0 refused → split)
finalize(id)             ← anyone, past any deadline
withdraw()
```

`Spec` = `{ domainTag, taskCount N, sampleSize k, weakModel, strongModel, weakMaxBps, strongMinBps, nullMaxBps, runs, toleranceBps, runParamsHash }`.

## Task and bundle format

A **task** is a JSON object:

```json
{ "index": 7, "family": "date_understanding", "difficulty": 3, "prompt": "…",
  "grader": { "type": "choice" | "numeric" | "exact" | "regex", "value": "B", "tolerance": 0 },
  "reference": "B", "sourceId": "bbh/date_understanding/17" }
```

`sourceId` is optional provenance. Grader semantics: `choice` compares the multiple-choice letter the
answer *concludes* with — an explicit marker ("answer: (B)", "the choice is B") wins, otherwise the
LAST letter mentioned ("(A) no, (B) yes" is B, not A). v1 took the first letter found, which graded
a model that reasons through the options before committing as having picked the first one it named;
that is the change v2 pins; `numeric` compares the last number in the
answer within `tolerance`; `exact` compares after trimming, stripping quotes and trailing punctuation,
collapsing whitespace and lower-casing; `regex` is case-insensitive.

A **bundle** is:

```json
{ "version": 1, "salt": "0x…32 bytes", "domainTag": "…", "runParams": {…},
  "tasks": [ …N tasks with index = position… ], "sellerMeasured": { "weak": bps, "strong": bps, "null": bps } }
```

**Canonical bytes** are RFC 8785 (JSON Canonicalization Scheme) UTF-8 of the value. All hashes below are
over canonical bytes, so independent implementations derive identical bytes from identical values.

- `bundleCommitment = keccak256(canonical(bundle))`
- `taskBytes_i = canonical(tasks[i])`, `taskHash_i = keccak256(taskBytes_i)`
- Merkle leaf `i` = OpenZeppelin StandardMerkleTree over `[uint256 index, bytes32 taskHash]`, i.e.
  `keccak256(bytes.concat(keccak256(abi.encode(index, taskHash))))`; pairs hashed with sorted
  (commutative) keccak256. `taskRoot` is the tree root. `revealSample` passes `taskBytes` and the proof for
  each sampled index; the contract recomputes the leaf.

## Run params (v1 constant)

The contract pins `runParamsHash = keccak256(canonical(runParams))`. In protocol v1 there is one
recognised value, so the hash acts as a version pin:

```json
{ "graderVersion": "2", "max_tokens": 64, "system": "You are being evaluated. Reply with only the final answer and nothing else.", "temperature": 0 }
```

`graderVersion` pins the *grading* semantics described above — answer normalisation, the number
parser, the set of grader types — not just how the model is sampled. Seller, buyer and arbitrator each
grade independently and money moves on whether their scores agree, so a change to grading is a change
to who wins a dispute. Bump it whenever the meaning of a score changes.

Self-check. Your canonical bytes and hash must be exactly:

```
{"graderVersion":"2","max_tokens":64,"system":"You are being evaluated. Reply with only the final answer and nothing else.","temperature":0}
keccak256 -> 0x6c1ca65c181d543864f0eb9ea44263830730d4fcdd77a6b1f5461bdf7793b3d5
```

If you do not reproduce that hash, your canonicalization or field set is wrong and every bounty will
be rejected as unrecognised. (Bundles committed before versioning omit `graderVersion` entirely; the
field is schema-optional for that reason alone, and absent means "pre-versioning".)

A seller must refuse bounties whose `runParamsHash` it does not recognise. Publishing the params
on-chain as a string is the planned v2 change.

## Sampling

`sampleIndices(id)` is deterministic from `blockhash(sampleBlock)`: draw
`uint256(keccak256(abi.encode(bh, id, nonce))) % N` for `nonce = 0, 1, …` until `k` distinct indices.
`sampleBlock = commit block + 1`; reveal within 256 blocks or the commit must be withdrawn (10% bond
penalty once the sample was knowable).

## Encryption and evidence

- Buyer key: X25519 public key (32 bytes) in `createBounty`.
- Ciphertext = `nonce(24) || crypto_box_seal(K, buyerPubKey)(80) || crypto_secretbox_easy(canonical(bundle), nonce, K)`
  with `K` = 32 random bytes (libsodium). Posted in `deliver`; it lives in the `Delivered` event log.
- `BadDelivery` evidence = the buyer's 32-byte X25519 secret key. The arbitrator must check that it
  derives the bounty's `buyerPubKey` (otherwise the buyer loses), then reproduce the decryption and
  commitment/root checks.
- `ClaimsFailed` evidence = `abi.encode(bytes sealedK, bytes32 transcriptHash)` where
  `sealedK = crypto_box_seal(K, arbiterPubKey)` and `arbiterPubKey` is read from
  `CentralizedArbitrator.arbiterPubKey()`.

## Committee arbitration (when `EvalBounty.arbitrator()` is a `CommitteeArbitrator`)

Detect it by calling `panelSize()` on the arbitrator address. Then:

- Jurors: `stake(bytes32 x25519PubKey)` with at least `minStake()`; the reference juror derives its key
  as BLAKE2b(wallet secret, `evalbounty/v1/juror/<chainId>/<committee>/<jurorAddr>`).
- Dispute lifecycle on the committee: `createDispute` (called by the market) → anyone `drawPanel(id)` once
  `block.number > sortitionBlock` → panel jurors `commitVote(id, keccak256(abi.encode(id, vote, salt, juror)))`
  before `commitBy` → `revealVote(id, vote, salt)` after `commitBy` or once all committed → anyone
  `execute(id)` after `revealBy` or once all revealed. Votes: 1 seller, 2 buyer, 0 too close to call.
- ClaimsFailed evidence in `EvalBounty.dispute` is `abi.encode(bytes "", bytes32 transcriptHash)` (no
  sealed key yet). After the panel is drawn the buyer calls
  `submitKeys(disputeId, bountyId, bytes[] sealedKeys)` with `crypto_box_seal(K, jurorPubKey_i)` in
  panel order. Jurors read `KeysSubmitted`. No handoff → jurors vote 1 (buyer failed to substantiate).
- Ruling: a vote held by ≥ ⌈2m/3⌉ jurors; otherwise 0. Incoherent or silent jurors lose `slashBps` of
  stake to the coherent ones, who also share `arbitrationCost = m · jurorFee`. Without a supermajority,
  nobody is slashed and revealers share the fee.
- `securedValue()` = ⌈2m/3⌉ · minStake · slashBps / lambda is the largest `reward + sellerBond` the pool
  secures; buyers should not post above it.

## Claims and scoring

`score(model) = mean over tasks of mean over runs of grader(answer) ∈ {0,1}`, in basis points, with the
pinned run params. `null` is the constant answer `"0"`. Claims hold iff
`weak ≤ weakMax + tol`, `strong ≥ strongMin − tol`, `null ≤ nullMax + tol`. The arbitrator applies the same
rule with its own rerun.

## A minimal third-party seller

No registration, SDK, allowlist or permission is involved — the contract does not know who is calling,
and the reference agents hold no privileges over yours. A working seller is roughly this loop.

```
abi  = fetch https://evalbounty.vercel.app/abi.js       # ABI
cfg  = fetch https://evalbounty.vercel.app/config.js    # address, chain id, deploy block

on BountyCreated(id, buyer, reward, spec, buyerPubKey):
    if spec.runParamsHash != keccak256(canonical(RUN_PARAMS)): skip   # you cannot grade it
    tasks  = build spec.taskCount tasks you believe sit inside the band
    check locally: weak <= weakMaxBps, strong >= strongMinBps, null <= nullMaxBps
    bundle = { version:1, salt:<32 random bytes>, domainTag, runParams, tasks, sellerMeasured }
    commit(id, taskRoot(bundle), keccak256(canonical(bundle)))   value = minSellerBond(id)

once block.number > sampleBlock:
    idx = sampleIndices(id)                       # or recompute it yourself from blockhash
    revealSample(id, [canonical(tasks[i]) for i in idx], [merkleProof(i) for i in idx])

on SampleApproved(id):
    K = 32 random bytes
    deliver(id, nonce || crypto_box_seal(K, buyerPubKey) || secretbox(canonical(bundle), nonce, K))

on Settled(id) or Refunded(id):
    withdraw()
```

Failure modes you must handle: the buyer rejects your sample (bond returned, bounty reopens, you keep
a reputation mark); you miss `deliverBy` (bond slashed in full to the buyer); the blockhash expires
before you reveal (withdraw the commit at a 10% penalty). Every deadline is also callable by anyone
via `finalize(id)`, so an abandoned bounty never locks funds.

## Reference-implementation choices (not part of the protocol)

Deterministic per-bounty keys (BLAKE2b of wallet secret + `evalbounty/v1/buyer/<chainId>/<contract>/<txNonce>`),
deterministic bundle salts, provider routing by model id, the benchmark snapshot and the difficulty
mixes, the buyer's objective sample checks. Another agent may do all of these differently.
