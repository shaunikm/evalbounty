// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IArbitrable} from "./interfaces/IArbitrable.sol";
import {IArbitrator} from "./interfaces/IArbitrator.sol";
import {IEvidence} from "./interfaces/IEvidence.sol";

/// @title EvalBounty — a sealed marketplace for hidden evaluation tasks.
///
/// A buyer posts a bounty describing the evaluation bundle it wants (domain, size, and a
/// difficulty band on pinned models) and escrows the reward. A seller commits to a hidden
/// bundle (Merkle root over the tasks + hash of the full bundle) and posts a bond. A random
/// sample of tasks, chosen by the hash of the block *after* the commit, must be revealed with
/// Merkle proofs so the buyer can judge quality without the seller cherry-picking. The rest is
/// delivered encrypted to the buyer's public key. The buyer reproduces the difficulty claims;
/// payment settles unless the buyer disputes, in which case an ERC-792 arbitrator rules.
///
/// Money never leaves the contract in the same call that decides who gets it: every payout is
/// credited to `pending[account]` and pulled with `withdraw()` (pull-payment pattern).
///
/// The contract enforces delivery and whether the listed claims hold. It does not, and cannot,
/// enforce that tasks are useful beyond the sampled ones or that they stay secret after sale.
contract EvalBounty is IArbitrable, IEvidence, Ownable, ReentrancyGuard {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Status {
        Open, // reward escrowed, waiting for a seller
        Committed, // seller committed root + bond, sample block not yet usable
        Sampled, // sample revealed with proofs, buyer must approve or reject
        Approved, // buyer approved the sample, seller must deliver ciphertext
        Delivered, // ciphertext posted, buyer must accept or dispute
        Disputed, // waiting for the arbitrator's ruling
        Settled, // seller paid (terminal)
        Refunded, // buyer refunded or funds split (terminal)
        Cancelled // buyer cancelled an open bounty (terminal)
    }

    enum DisputeKind {
        BadDelivery, // ciphertext does not decrypt to the committed bundle / root
        ClaimsFailed // bundle decrypts fine but the difficulty band does not reproduce
    }

    /// What the buyer wants. Immutable after creation.
    struct Spec {
        string domainTag; // e.g. "exact-answer-reasoning"
        uint32 taskCount; // N tasks in the bundle
        uint8 sampleSize; // k tasks revealed before purchase
        string weakModel; // pinned model id that must score LOW
        string strongModel; // pinned model id that must score HIGH (headroom => solvable)
        uint16 weakMaxBps; // weak model score <= this (basis points of 100%)
        uint16 strongMinBps; // strong model score >= this
        uint16 nullMaxBps; // empty-answer policy score <= this (grader is not trivial)
        uint8 runs; // samples per task per model
        uint16 toleranceBps; // dispute margin; buyer should set >= 2 standard errors
        bytes32 runParamsHash; // keccak256 of canonical run-params JSON (temperature, max tokens, system prompt)
    }

    struct Bounty {
        address buyer;
        bytes32 buyerPubKey; // X25519 public key for sealed-box delivery
        uint256 reward;
        Spec spec;
        Status status;
        // seller side
        address seller;
        uint256 sellerBond;
        bytes32 taskRoot; // Merkle root over (index, keccak256(taskBytes)) leaves
        bytes32 bundleCommitment; // keccak256(plaintext bundle bytes)
        uint256 sampleBlock; // blockhash of this block selects the sample
        // delivery / dispute
        bytes32 ciphertextHash;
        uint64 approveBy;
        uint64 deliverBy;
        uint64 verifyBy;
        uint64 ruleBy;
        uint256 disputeBond;
        DisputeKind disputeKind;
        IArbitrator arbitrator; // arbitrator pinned at dispute time
        uint256 disputeId;
    }

    struct Windows {
        uint64 approve; // buyer judges the sample
        uint64 deliver; // seller posts ciphertext
        uint64 verify; // buyer accepts or disputes
        uint64 rule; // arbitrator rules
    }

    struct SellerRep {
        uint32 commits;
        uint32 samplesRejected;
        uint32 commitsAbandoned;
        uint32 delivered;
        uint32 deliveryTimeouts;
        uint32 settled;
        uint32 disputesWon;
        uint32 disputesLost;
        uint256 volumeWei;
    }

    struct BuyerRep {
        uint32 created;
        uint32 settled;
        uint32 disputesRaised;
        uint32 disputesLost;
    }

    // ------------------------------------------------------------------
    // Constants / parameters
    // ------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    uint256 public constant RULING_REFUSED = 0; // ERC-792: arbitrator refused / no ruling => split
    uint256 public constant RULING_SELLER = 1;
    uint256 public constant RULING_BUYER = 2;
    uint256 public constant MAX_SAMPLE = 16;
    uint256 public constant BLOCKHASH_WINDOW = 256;

    IArbitrator public arbitrator;
    address public treasury;
    uint16 public feeBps = 200; // 2% of reward to treasury on settle
    uint16 public minSellerBondBps = 5000; // seller bond >= 50% of reward
    uint16 public disputeBondBps = 5000; // buyer dispute bond = 50% of reward
    uint16 public abandonPenaltyBps = 1000; // 10% of bond if a seller walks after seeing its sample
    Windows public windows;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    uint256 public bountyCount;
    mapping(uint256 => Bounty) internal _bounties;
    mapping(address => uint256) public pending;
    mapping(address => SellerRep) public sellerRep;
    mapping(address => BuyerRep) public buyerRep;
    /// arbitrator => disputeId => bountyId + 1 (0 means unknown)
    mapping(address => mapping(uint256 => uint256)) internal _disputeToBounty;

    // ------------------------------------------------------------------
    // Events (the agents and the dashboard are built entirely on these)
    // ------------------------------------------------------------------

    event BountyCreated(uint256 indexed id, address indexed buyer, uint256 reward, Spec spec, bytes32 buyerPubKey);
    event BountyCancelled(uint256 indexed id);
    event Committed(
        uint256 indexed id,
        address indexed seller,
        bytes32 taskRoot,
        bytes32 bundleCommitment,
        uint256 bond,
        uint256 sampleBlock
    );
    event SampleRevealed(uint256 indexed id, uint256 index, bytes task);
    event SampleComplete(uint256 indexed id, uint64 approveBy);
    event SampleApproved(uint256 indexed id, uint64 deliverBy);
    event SampleRejected(uint256 indexed id, address indexed seller, string reason);
    event CommitWithdrawn(uint256 indexed id, address indexed seller, uint256 penalty);
    event Delivered(uint256 indexed id, bytes32 ciphertextHash, bytes ciphertext, uint64 verifyBy);
    event Accepted(uint256 indexed id);
    event Disputed(uint256 indexed id, DisputeKind kind, uint256 disputeId, bytes evidence, uint64 ruleBy);
    event Settled(uint256 indexed id, address indexed seller, uint256 sellerPayout, uint256 fee);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 buyerPayout);
    event Split(uint256 indexed id, uint256 buyerPayout, uint256 sellerPayout);
    event Finalized(uint256 indexed id, string reason);
    event Withdrawn(address indexed account, uint256 amount);
    event ParamsUpdated(uint16 feeBps, uint16 minSellerBondBps, uint16 disputeBondBps, uint16 abandonPenaltyBps);
    event WindowsUpdated(Windows windows);
    event ArbitratorUpdated(IArbitrator arbitrator);
    event TreasuryUpdated(address treasury);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error WrongStatus(Status actual);
    error NotBuyer();
    error NotSeller();
    error NotArbitrator();
    error TooEarly();
    error TooLate();
    error SampleExpired();
    error InvalidProof(uint256 index);
    error InsufficientBond(uint256 required);
    error InvalidSpec(string reason);
    error BadValue();
    error LengthMismatch();
    error NothingToWithdraw();
    error TransferFailed();
    error UnknownBounty();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(IArbitrator arbitrator_, address treasury_, Windows memory windows_, string memory metaEvidenceURI)
        Ownable(msg.sender)
    {
        if (address(arbitrator_) == address(0) || treasury_ == address(0)) revert BadValue();
        arbitrator = arbitrator_;
        treasury = treasury_;
        windows = windows_;
        // ERC-1497: one meta-evidence document (dispute policy + ruling options) for all disputes.
        emit MetaEvidence(0, metaEvidenceURI);
    }

    // ------------------------------------------------------------------
    // Buyer: create / cancel
    // ------------------------------------------------------------------

    /// @notice Post a bounty and escrow the reward. `buyerPubKey` is the X25519 key the seller
    ///         must encrypt the bundle to.
    function createBounty(Spec calldata spec, bytes32 buyerPubKey) external payable returns (uint256 id) {
        if (msg.value == 0 || buyerPubKey == bytes32(0)) revert BadValue();
        _validateSpec(spec);
        id = bountyCount++;
        Bounty storage b = _bounties[id];
        b.buyer = msg.sender;
        b.buyerPubKey = buyerPubKey;
        b.reward = msg.value;
        b.spec = spec;
        b.status = Status.Open;
        buyerRep[msg.sender].created++;
        emit BountyCreated(id, msg.sender, msg.value, spec, buyerPubKey);
    }

    /// @notice Cancel an open bounty (no seller committed). Reward is credited back.
    function cancelBounty(uint256 id) external {
        Bounty storage b = _get(id);
        _onlyBuyer(b);
        _requireStatus(b, Status.Open);
        b.status = Status.Cancelled;
        pending[b.buyer] += b.reward;
        emit BountyCancelled(id);
    }

    // ------------------------------------------------------------------
    // Seller: commit / reveal / withdraw / deliver
    // ------------------------------------------------------------------

    /// @notice Commit to a hidden bundle. The sample is chosen by the hash of the NEXT block,
    ///         so the seller cannot know which tasks will be shown when it commits.
    function commit(uint256 id, bytes32 taskRoot, bytes32 bundleCommitment) external payable {
        Bounty storage b = _get(id);
        _requireStatus(b, Status.Open);
        uint256 minBond = (b.reward * minSellerBondBps) / BPS;
        if (msg.value < minBond) revert InsufficientBond(minBond);
        if (taskRoot == bytes32(0) || bundleCommitment == bytes32(0)) revert BadValue();
        b.seller = msg.sender;
        b.sellerBond = msg.value;
        b.taskRoot = taskRoot;
        b.bundleCommitment = bundleCommitment;
        b.sampleBlock = block.number + 1;
        b.status = Status.Committed;
        sellerRep[msg.sender].commits++;
        emit Committed(id, msg.sender, taskRoot, bundleCommitment, msg.value, b.sampleBlock);
    }

    /// @notice Deterministic sample indices for a bounty. Reverts before the sample block has
    ///         passed and after its blockhash has expired (256 blocks).
    function sampleIndices(uint256 id) public view returns (uint256[] memory) {
        Bounty storage b = _get(id);
        if (b.sampleBlock == 0 || block.number <= b.sampleBlock) revert TooEarly();
        bytes32 bh = blockhash(b.sampleBlock);
        if (bh == bytes32(0)) revert SampleExpired();
        return sampleIndicesFor(bh, id, b.spec.taskCount, b.spec.sampleSize);
    }

    /// @notice Pure sample-selection rule. Mirrored byte-for-byte in agents/src/lib/merkle.ts.
    ///         Draw keccak256(bh, id, nonce) mod N until k distinct indices are found.
    function sampleIndicesFor(bytes32 bh, uint256 id, uint32 n, uint8 k) public pure returns (uint256[] memory idx) {
        idx = new uint256[](k);
        uint256 count;
        uint256 nonce;
        while (count < k) {
            uint256 cand = uint256(keccak256(abi.encode(bh, id, nonce))) % n;
            bool dup;
            for (uint256 j; j < count; ++j) {
                if (idx[j] == cand) {
                    dup = true;
                    break;
                }
            }
            if (!dup) idx[count++] = cand;
            ++nonce;
        }
    }

    /// @notice Reveal the sampled tasks with Merkle proofs against the committed root.
    ///         Leaf format is OpenZeppelin StandardMerkleTree with types (uint256, bytes32):
    ///         keccak256(bytes.concat(keccak256(abi.encode(index, keccak256(taskBytes))))).
    function revealSample(uint256 id, bytes[] calldata tasks, bytes32[][] calldata proofs) external {
        Bounty storage b = _get(id);
        _onlySeller(b);
        _requireStatus(b, Status.Committed);
        uint256[] memory idx = sampleIndices(id);
        if (tasks.length != idx.length || proofs.length != idx.length) revert LengthMismatch();
        for (uint256 j; j < idx.length; ++j) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(idx[j], keccak256(tasks[j])))));
            if (!MerkleProof.verify(proofs[j], b.taskRoot, leaf)) revert InvalidProof(idx[j]);
            emit SampleRevealed(id, idx[j], tasks[j]);
        }
        b.status = Status.Sampled;
        b.approveBy = uint64(block.timestamp) + windows.approve;
        emit SampleComplete(id, b.approveBy);
    }

    /// @notice Seller backs out. Free before the sample is knowable; costs `abandonPenaltyBps`
    ///         of the bond once the sample block has passed, because "commit, peek at the
    ///         sample, walk away, recommit" is otherwise a free re-roll. After a reveal, the
    ///         seller may only leave once the buyer's approval window has lapsed (no penalty).
    function withdrawCommit(uint256 id) external {
        Bounty storage b = _get(id);
        _onlySeller(b);
        uint256 penalty;
        if (b.status == Status.Committed) {
            if (block.number > b.sampleBlock) penalty = (b.sellerBond * abandonPenaltyBps) / BPS;
        } else if (b.status == Status.Sampled) {
            if (block.timestamp <= b.approveBy) revert TooEarly();
        } else {
            revert WrongStatus(b.status);
        }
        _releaseSeller(b, id, penalty);
    }

    /// @notice Post the encrypted bundle. The ciphertext lives in the event log, only its hash
    ///         in storage. Format: nonce(24) || sealedKey(80) || secretbox(bundle).
    function deliver(uint256 id, bytes calldata ciphertext) external {
        Bounty storage b = _get(id);
        _onlySeller(b);
        _requireStatus(b, Status.Approved);
        if (block.timestamp > b.deliverBy) revert TooLate();
        if (ciphertext.length == 0) revert BadValue();
        b.ciphertextHash = keccak256(ciphertext);
        b.status = Status.Delivered;
        b.verifyBy = uint64(block.timestamp) + windows.verify;
        sellerRep[b.seller].delivered++;
        emit Delivered(id, b.ciphertextHash, ciphertext, b.verifyBy);
    }

    // ------------------------------------------------------------------
    // Buyer: judge sample / accept / dispute
    // ------------------------------------------------------------------

    function approveSample(uint256 id) external {
        Bounty storage b = _get(id);
        _onlyBuyer(b);
        _requireStatus(b, Status.Sampled);
        b.status = Status.Approved;
        b.deliverBy = uint64(block.timestamp) + windows.deliver;
        emit SampleApproved(id, b.deliverBy);
    }

    /// @notice Subjective walk-away. The seller is never slashed for a rejected sample; it gets
    ///         its bond back, a reputation mark, and the bounty reopens for other sellers.
    function rejectSample(uint256 id, string calldata reason) external {
        Bounty storage b = _get(id);
        _onlyBuyer(b);
        _requireStatus(b, Status.Sampled);
        sellerRep[b.seller].samplesRejected++;
        emit SampleRejected(id, b.seller, reason);
        _releaseSeller(b, id, 0);
    }

    function accept(uint256 id) external {
        Bounty storage b = _get(id);
        _onlyBuyer(b);
        _requireStatus(b, Status.Delivered);
        emit Accepted(id);
        _settleToSeller(b, id);
    }

    /// @notice Open a dispute. Buyer posts a dispute bond plus the arbitration fee.
    ///         BadDelivery evidence: the 32-byte bundle key in the clear, so anyone can decrypt the
    ///         event ciphertext and check the commitment (this publishes the bundle; rational only
    ///         if it is worthless). ClaimsFailed evidence: the key sealed to the arbitrator's
    ///         public key plus the buyer's transcript hash.
    function dispute(uint256 id, DisputeKind kind, bytes calldata evidence) external payable nonReentrant {
        Bounty storage b = _get(id);
        _onlyBuyer(b);
        _requireStatus(b, Status.Delivered);
        if (block.timestamp > b.verifyBy) revert TooLate();
        uint256 bond = (b.reward * disputeBondBps) / BPS;
        uint256 cost = arbitrator.arbitrationCost("");
        if (msg.value != bond + cost) revert BadValue();

        b.disputeBond = bond;
        b.disputeKind = kind;
        b.arbitrator = arbitrator;
        b.status = Status.Disputed;
        b.ruleBy = uint64(block.timestamp) + windows.rule;
        buyerRep[b.buyer].disputesRaised++;

        uint256 disputeId = arbitrator.createDispute{value: cost}(2, "");
        b.disputeId = disputeId;
        _disputeToBounty[address(arbitrator)][disputeId] = id + 1;

        emit Disputed(id, kind, disputeId, evidence, b.ruleBy);
        emit Dispute(arbitrator, disputeId, 0, id); // ERC-1497
    }

    /// @notice Either party can attach evidence (a URI or inline JSON) to an open dispute.
    function submitEvidence(uint256 id, string calldata evidenceURI) external {
        Bounty storage b = _get(id);
        if (msg.sender != b.buyer && msg.sender != b.seller) revert NotBuyer();
        _requireStatus(b, Status.Disputed);
        emit Evidence(b.arbitrator, id, msg.sender, evidenceURI);
    }

    // ------------------------------------------------------------------
    // Arbitrator callback (ERC-792)
    // ------------------------------------------------------------------

    /// @inheritdoc IArbitrable
    /// @dev 1 = seller wins (settle + buyer's dispute bond to seller). 2 = buyer wins (reward,
    ///      dispute bond and seller bond to buyer). 0 = refused to arbitrate => reward split
    ///      50/50 and bonds returned.
    function rule(uint256 disputeID, uint256 ruling) external override {
        uint256 idPlus = _disputeToBounty[msg.sender][disputeID];
        if (idPlus == 0) revert NotArbitrator();
        uint256 id = idPlus - 1;
        Bounty storage b = _bounties[id];
        if (address(b.arbitrator) != msg.sender) revert NotArbitrator();
        _requireStatus(b, Status.Disputed);
        if (ruling > RULING_BUYER) revert BadValue();
        emit Ruling(IArbitrator(msg.sender), disputeID, ruling);
        _applyRuling(b, id, ruling);
    }

    // ------------------------------------------------------------------
    // Liveness: anyone can push a stalled bounty past its deadline
    // ------------------------------------------------------------------

    function finalize(uint256 id) external {
        Bounty storage b = _get(id);
        uint64 t = uint64(block.timestamp);
        if (b.status == Status.Committed) {
            // Seller never revealed and the blockhash expired: buyer's funds must not stay locked.
            if (block.number <= b.sampleBlock + BLOCKHASH_WINDOW) revert TooEarly();
            emit Finalized(id, "seller never revealed the sample; penalty to buyer, bounty reopened");
            _releaseSeller(b, id, (b.sellerBond * abandonPenaltyBps) / BPS);
        } else if (b.status == Status.Sampled) {
            if (t <= b.approveBy) revert TooEarly();
            emit Finalized(id, "buyer did not judge the sample in time; bond returned, bounty reopened");
            _releaseSeller(b, id, 0);
        } else if (b.status == Status.Approved) {
            if (t <= b.deliverBy) revert TooEarly();
            sellerRep[b.seller].deliveryTimeouts++;
            emit Finalized(id, "seller missed delivery; bond slashed to buyer, bounty reopened");
            _releaseSeller(b, id, b.sellerBond);
        } else if (b.status == Status.Delivered) {
            if (t <= b.verifyBy) revert TooEarly();
            emit Finalized(id, "buyer neither accepted nor disputed in time; settled to seller");
            _settleToSeller(b, id);
        } else if (b.status == Status.Disputed) {
            if (t <= b.ruleBy) revert TooEarly();
            emit Finalized(id, "arbitrator missed the ruling deadline; reward split, bonds returned");
            _applyRuling(b, id, RULING_REFUSED);
        } else {
            revert WrongStatus(b.status);
        }
    }

    // ------------------------------------------------------------------
    // Pull payments
    // ------------------------------------------------------------------

    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pending[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getBounty(uint256 id) external view returns (Bounty memory) {
        return _get(id);
    }

    function getSpec(uint256 id) external view returns (Spec memory) {
        return _get(id).spec;
    }

    function minSellerBond(uint256 id) external view returns (uint256) {
        return (_get(id).reward * minSellerBondBps) / BPS;
    }

    function disputeCost(uint256 id) external view returns (uint256) {
        return (_get(id).reward * disputeBondBps) / BPS + arbitrator.arbitrationCost("");
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setArbitrator(IArbitrator arbitrator_) external onlyOwner {
        if (address(arbitrator_) == address(0)) revert BadValue();
        arbitrator = arbitrator_;
        emit ArbitratorUpdated(arbitrator_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert BadValue();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setParams(uint16 feeBps_, uint16 minSellerBondBps_, uint16 disputeBondBps_, uint16 abandonPenaltyBps_)
        external
        onlyOwner
    {
        if (feeBps_ > 1000 || minSellerBondBps_ > BPS || disputeBondBps_ > BPS || abandonPenaltyBps_ > BPS) {
            revert BadValue();
        }
        feeBps = feeBps_;
        minSellerBondBps = minSellerBondBps_;
        disputeBondBps = disputeBondBps_;
        abandonPenaltyBps = abandonPenaltyBps_;
        emit ParamsUpdated(feeBps_, minSellerBondBps_, disputeBondBps_, abandonPenaltyBps_);
    }

    function setWindows(Windows calldata windows_) external onlyOwner {
        windows = windows_;
        emit WindowsUpdated(windows_);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _validateSpec(Spec calldata s) internal pure {
        if (s.sampleSize == 0 || s.sampleSize > MAX_SAMPLE) revert InvalidSpec("sampleSize must be 1..16");
        if (s.taskCount < s.sampleSize) revert InvalidSpec("taskCount < sampleSize");
        if (s.runs == 0) revert InvalidSpec("runs must be >= 1");
        if (s.weakMaxBps > BPS || s.strongMinBps > BPS || s.nullMaxBps > BPS || s.toleranceBps > BPS) {
            revert InvalidSpec("bps out of range");
        }
        if (s.strongMinBps <= s.weakMaxBps) revert InvalidSpec("strongMin must exceed weakMax");
        if (bytes(s.weakModel).length == 0 || bytes(s.strongModel).length == 0) revert InvalidSpec("model ids required");
    }

    function _get(uint256 id) internal view returns (Bounty storage b) {
        if (id >= bountyCount) revert UnknownBounty();
        b = _bounties[id];
    }

    function _requireStatus(Bounty storage b, Status expected) internal view {
        if (b.status != expected) revert WrongStatus(b.status);
    }

    function _onlyBuyer(Bounty storage b) internal view {
        if (msg.sender != b.buyer) revert NotBuyer();
    }

    function _onlySeller(Bounty storage b) internal view {
        if (msg.sender != b.seller) revert NotSeller();
    }

    /// Return the seller's bond minus `penalty` (credited to the buyer), forget the seller,
    /// and reopen the bounty.
    function _releaseSeller(Bounty storage b, uint256 id, uint256 penalty) internal {
        address seller = b.seller;
        uint256 bond = b.sellerBond;
        if (penalty > 0) {
            pending[b.buyer] += penalty;
            if (penalty < bond) sellerRep[seller].commitsAbandoned++;
        }
        pending[seller] += bond - penalty;
        emit CommitWithdrawn(id, seller, penalty);
        b.seller = address(0);
        b.sellerBond = 0;
        b.taskRoot = bytes32(0);
        b.bundleCommitment = bytes32(0);
        b.sampleBlock = 0;
        b.approveBy = 0;
        b.deliverBy = 0;
        b.status = Status.Open;
    }

    function _settleToSeller(Bounty storage b, uint256 id) internal {
        uint256 fee = (b.reward * feeBps) / BPS;
        uint256 payout = b.reward - fee + b.sellerBond;
        pending[treasury] += fee;
        pending[b.seller] += payout;
        SellerRep storage sr = sellerRep[b.seller];
        sr.settled++;
        sr.volumeWei += b.reward;
        buyerRep[b.buyer].settled++;
        b.status = Status.Settled;
        emit Settled(id, b.seller, payout, fee);
    }

    function _applyRuling(Bounty storage b, uint256 id, uint256 ruling) internal {
        if (ruling == RULING_SELLER) {
            sellerRep[b.seller].disputesWon++;
            buyerRep[b.buyer].disputesLost++;
            pending[b.seller] += b.disputeBond;
            _settleToSeller(b, id);
        } else if (ruling == RULING_BUYER) {
            sellerRep[b.seller].disputesLost++;
            uint256 payout = b.reward + b.disputeBond + b.sellerBond;
            pending[b.buyer] += payout;
            b.status = Status.Refunded;
            emit Refunded(id, b.buyer, payout);
        } else {
            // Refused / no ruling: nobody is proven wrong. Split the reward, return both bonds.
            uint256 half = b.reward / 2;
            uint256 buyerPayout = half + b.disputeBond;
            uint256 sellerPayout = (b.reward - half) + b.sellerBond;
            pending[b.buyer] += buyerPayout;
            pending[b.seller] += sellerPayout;
            b.status = Status.Refunded;
            emit Split(id, buyerPayout, sellerPayout);
        }
    }
}
