// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArbitrator} from "./interfaces/IArbitrator.sol";
import {IArbitrable} from "./interfaces/IArbitrable.sol";
import {EvalBounty} from "./EvalBounty.sol";

/// @title CommitteeArbitrator — ERC-792 arbitrator ruled by a sortitioned, staked juror panel.
///
/// Threat model this replaces: a single arbitrator key with nothing at stake, which the buyer could
/// be, know, or bribe. Here:
///   1. Sortition. The panel for a dispute is drawn from the staked pool by the hash of the block
///      AFTER the dispute was created (the same primitive EvalBounty uses to pick sample tasks), so
///      neither party nor the owner chooses the judges, and nobody knows them at dispute time.
///   2. Stake. Jurors post stake; jurors who vote against a two-thirds supermajority (or do not
///      reveal) lose `slashBps` of it to the coherent jurors, who also share the fee.
///   3. Commit–reveal. Votes are committed as hashes and revealed later, so a bribed juror cannot
///      prove how it voted before the reveal and jurors cannot copy each other.
///   4. No-slash zone. The predicate ("do the claims reproduce?") is objective but model inference
///      is only near-deterministic, so a bundle at the band edge can split honest jurors. If no vote
///      reaches two thirds of the panel, the ruling is 0 (refused → EvalBounty splits 50/50) and
///      nobody is slashed. Honest disagreement is treated as honest.
///   5. Economic sizing. `securedValue()` = (stake a supermajority must forfeit) / lambda is the
///      largest profit-from-corruption this pool can secure; buyers must not post bounties above it.
///
/// Rulings follow EvalBounty's convention: 1 seller, 2 buyer, 0 refused. Appeals are not supported
/// (a losing party's recourse is the reputation counters and the no-slash zone); they are the
/// documented next step. Fees and slashes are pull-payments.
contract CommitteeArbitrator is IArbitrator, Ownable, ReentrancyGuard {
    // ------------------------------------------------------------------ types

    struct Juror {
        uint256 stake;
        bytes32 pubKey; // X25519 key buyers seal the bundle key to
        uint32 activePanels;
        bool registered;
    }

    struct Dispute {
        IArbitrable arbitrable;
        uint256 choices;
        uint256 ruling;
        DisputeStatus status;
        uint256 sortitionBlock; // blockhash of this block draws the panel
        address[] panel;
        uint64 commitBy;
        uint64 revealBy;
        uint256 fee; // paid at creation, shared by coherent jurors
        uint8 revealed;
        bytes32 keysHash; // keccak256 of the sealed keys the buyer posted (0 if none)
    }

    // ------------------------------------------------------------------ parameters

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_JURORS = 64; // bounds the sortition loop
    uint256 public constant BLOCKHASH_WINDOW = 256;

    uint256 public minStake;
    uint256 public jurorFee; // per juror per dispute
    uint8 public panelSize; // m
    uint64 public commitWindow;
    uint64 public revealWindow;
    uint16 public slashBps; // fraction of stake an incoherent juror loses
    uint16 public lambda; // securedValue = CoC / lambda

    // ------------------------------------------------------------------ storage

    address[] public jurorList;
    mapping(address => Juror) public jurorInfo;
    uint256 public totalStake;

    uint256 public disputeCount;
    mapping(uint256 => Dispute) internal _disputes;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    /// vote + 1 once revealed (0 = not revealed)
    mapping(uint256 => mapping(address => uint8)) public revealedVote;
    mapping(address => uint256) public pending;

    // ------------------------------------------------------------------ events

    event JurorStaked(address indexed juror, uint256 stake, bytes32 pubKey);
    event JurorUnstaked(address indexed juror, uint256 amount);
    event JurorKeyUpdated(address indexed juror, bytes32 pubKey);
    event PanelDrawn(uint256 indexed disputeID, address[] panel, uint256 sortitionBlock, uint64 commitBy, uint64 revealBy);
    event PanelRedraw(uint256 indexed disputeID, uint256 newSortitionBlock);
    event KeysSubmitted(uint256 indexed disputeID, bytes[] sealedKeys);
    event VoteCommitted(uint256 indexed disputeID, address indexed juror);
    event VoteRevealed(uint256 indexed disputeID, address indexed juror, uint8 vote);
    event JurorSlashed(uint256 indexed disputeID, address indexed juror, uint256 amount);
    event Executed(uint256 indexed disputeID, uint256 ruling, uint8 coherent, uint8 revealed, uint256 slashedTotal);
    event RulingNotDelivered(uint256 indexed disputeID, uint256 ruling, bytes reason);
    event Withdrawn(address indexed account, uint256 amount);
    event ParamsUpdated(uint256 minStake, uint256 jurorFee, uint8 panelSize, uint64 commitWindow, uint64 revealWindow, uint16 slashBps, uint16 lambda);

    // ------------------------------------------------------------------ errors

    error InsufficientPayment(uint256 required);
    error InsufficientStake(uint256 required);
    error NotEnoughJurors(uint256 eligible, uint256 needed);
    error OnPanel();
    error NotOnPanel();
    error TooEarly();
    error TooLate();
    error SampleExpired();
    error AlreadyDrawn();
    error NotDrawn();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error BadReveal();
    error InvalidVote();
    error WrongStatus();
    error AppealsNotSupported();
    error NotBuyer();
    error WrongDispute();
    error LengthMismatch();
    error NothingToWithdraw();
    error TransferFailed();
    error TooManyJurors();
    error BadParams();

    // ------------------------------------------------------------------ constructor

    constructor(
        address owner_,
        uint256 minStake_,
        uint256 jurorFee_,
        uint8 panelSize_,
        uint64 commitWindow_,
        uint64 revealWindow_,
        uint16 slashBps_,
        uint16 lambda_
    ) Ownable(owner_) {
        _setParams(minStake_, jurorFee_, panelSize_, commitWindow_, revealWindow_, slashBps_, lambda_);
    }

    // ------------------------------------------------------------------ jurors

    /// @notice Register or top up. Total stake must reach `minStake` to be eligible for sortition.
    function stake(bytes32 pubKey) external payable {
        Juror storage j = jurorInfo[msg.sender];
        if (!j.registered) {
            if (jurorList.length >= MAX_JURORS) revert TooManyJurors();
            j.registered = true;
            jurorList.push(msg.sender);
        }
        j.stake += msg.value;
        if (j.stake < minStake) revert InsufficientStake(minStake);
        if (pubKey != bytes32(0)) j.pubKey = pubKey;
        totalStake += msg.value;
        emit JurorStaked(msg.sender, j.stake, j.pubKey);
    }

    function setJurorKey(bytes32 pubKey) external {
        if (!jurorInfo[msg.sender].registered) revert NotOnPanel();
        jurorInfo[msg.sender].pubKey = pubKey;
        emit JurorKeyUpdated(msg.sender, pubKey);
    }

    /// @notice Withdraw stake. Only while not sitting on an open panel; a partial withdrawal must
    ///         leave at least `minStake` (otherwise exit fully).
    function unstake(uint256 amount) external {
        Juror storage j = jurorInfo[msg.sender];
        if (j.activePanels != 0) revert OnPanel();
        if (amount > j.stake) revert InsufficientStake(j.stake);
        uint256 remaining = j.stake - amount;
        if (remaining != 0 && remaining < minStake) revert InsufficientStake(minStake);
        j.stake = remaining;
        totalStake -= amount;
        pending[msg.sender] += amount;
        emit JurorUnstaked(msg.sender, amount);
    }

    function eligibleJurors() public view returns (uint256 n) {
        for (uint256 i; i < jurorList.length; ++i) {
            if (jurorInfo[jurorList[i]].stake >= minStake) ++n;
        }
    }

    /// @notice Stake a corrupt supermajority must forfeit (cost of corruption).
    function costOfCorruption() public view returns (uint256) {
        return (_supermajority(panelSize) * minStake * slashBps) / BPS;
    }

    /// @notice Largest profit-from-corruption (reward + seller bond) this pool secures: CoC / lambda.
    ///         Buyers should refuse to post bounties whose reward + bond exceed this.
    function securedValue() external view returns (uint256) {
        return costOfCorruption() / lambda;
    }

    // ------------------------------------------------------------------ IArbitrator

    function arbitrationCost(bytes calldata) external view override returns (uint256) {
        return uint256(panelSize) * jurorFee;
    }

    function createDispute(uint256 _choices, bytes calldata) external payable override returns (uint256 disputeID) {
        uint256 cost = uint256(panelSize) * jurorFee;
        if (msg.value < cost) revert InsufficientPayment(cost);
        uint256 eligible = eligibleJurors();
        if (eligible < panelSize) revert NotEnoughJurors(eligible, panelSize);
        disputeID = disputeCount++;
        Dispute storage d = _disputes[disputeID];
        d.arbitrable = IArbitrable(msg.sender);
        d.choices = _choices;
        d.status = DisputeStatus.Waiting;
        d.sortitionBlock = block.number + 1;
        d.fee = msg.value;
        emit DisputeCreation(disputeID, IArbitrable(msg.sender));
    }

    function appeal(uint256, bytes calldata) external payable override {
        revert AppealsNotSupported();
    }

    function appealCost(uint256, bytes calldata) external pure override returns (uint256) {
        return type(uint256).max;
    }

    function appealPeriod(uint256) external pure override returns (uint256, uint256) {
        return (0, 0);
    }

    function disputeStatus(uint256 _disputeID) external view override returns (DisputeStatus) {
        return _disputes[_disputeID].status;
    }

    function currentRuling(uint256 _disputeID) external view override returns (uint256) {
        return _disputes[_disputeID].ruling;
    }

    // ------------------------------------------------------------------ sortition

    /// @notice Deterministic weighted draw of `panelSize` distinct eligible jurors from
    ///         blockhash(sortitionBlock). Anyone may call once that block has passed.
    function panelFor(bytes32 bh, uint256 disputeID) public view returns (address[] memory panel) {
        uint256 n = jurorList.length;
        address[] memory addrs = new address[](n);
        uint256[] memory weights = new uint256[](n);
        uint256 remaining;
        for (uint256 i; i < n; ++i) {
            Juror storage j = jurorInfo[jurorList[i]];
            addrs[i] = jurorList[i];
            if (j.stake >= minStake) {
                weights[i] = j.stake;
                remaining += j.stake;
            }
        }
        panel = new address[](panelSize);
        uint256 nonce;
        for (uint256 k; k < panelSize; ++k) {
            if (remaining == 0) revert NotEnoughJurors(k, panelSize);
            uint256 r = uint256(keccak256(abi.encode(bh, disputeID, nonce++))) % remaining;
            uint256 acc;
            for (uint256 i; i < n; ++i) {
                if (weights[i] == 0) continue;
                acc += weights[i];
                if (r < acc) {
                    panel[k] = addrs[i];
                    remaining -= weights[i];
                    weights[i] = 0;
                    break;
                }
            }
        }
    }

    function drawPanel(uint256 disputeID) external {
        Dispute storage d = _disputes[disputeID];
        if (d.status != DisputeStatus.Waiting) revert WrongStatus();
        if (d.panel.length != 0) revert AlreadyDrawn();
        if (block.number <= d.sortitionBlock) revert TooEarly();
        bytes32 bh = blockhash(d.sortitionBlock);
        if (bh == bytes32(0)) {
            // Nobody drew within 256 blocks: re-roll from a fresh future block.
            d.sortitionBlock = block.number + 1;
            emit PanelRedraw(disputeID, d.sortitionBlock);
            return;
        }
        address[] memory panel = panelFor(bh, disputeID);
        for (uint256 i; i < panel.length; ++i) {
            d.panel.push(panel[i]);
            jurorInfo[panel[i]].activePanels++;
        }
        d.commitBy = uint64(block.timestamp) + commitWindow;
        d.revealBy = d.commitBy + revealWindow;
        emit PanelDrawn(disputeID, panel, d.sortitionBlock, d.commitBy, d.revealBy);
    }

    // ------------------------------------------------------------------ evidence handoff

    /// @notice The buyer seals the bundle key to each drawn juror's X25519 key (ClaimsFailed
    ///         disputes). Verified against the market: the caller must be the bounty's buyer and the
    ///         bounty must reference this dispute.
    function submitKeys(uint256 disputeID, uint256 bountyId, bytes[] calldata sealedKeys) external {
        Dispute storage d = _disputes[disputeID];
        if (d.status != DisputeStatus.Waiting) revert WrongStatus();
        if (d.panel.length == 0) revert NotDrawn();
        if (sealedKeys.length != d.panel.length) revert LengthMismatch();
        EvalBounty.Bounty memory b = EvalBounty(address(d.arbitrable)).getBounty(bountyId);
        if (address(b.arbitrator) != address(this) || b.disputeId != disputeID) revert WrongDispute();
        if (msg.sender != b.buyer) revert NotBuyer();
        d.keysHash = keccak256(abi.encode(sealedKeys));
        emit KeysSubmitted(disputeID, sealedKeys);
    }

    // ------------------------------------------------------------------ voting

    function commitVote(uint256 disputeID, bytes32 commitment) external {
        Dispute storage d = _disputes[disputeID];
        if (d.status != DisputeStatus.Waiting || d.panel.length == 0) revert NotDrawn();
        if (!_onPanel(d, msg.sender)) revert NotOnPanel();
        if (block.timestamp > d.commitBy) revert TooLate();
        if (commitments[disputeID][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (commitment == bytes32(0)) revert BadReveal();
        commitments[disputeID][msg.sender] = commitment;
        emit VoteCommitted(disputeID, msg.sender);
    }

    /// @notice Reveal after the commit window (or once every juror has committed).
    ///         commitment = keccak256(abi.encode(disputeID, vote, salt, juror)).
    function revealVote(uint256 disputeID, uint8 vote, bytes32 salt) external {
        Dispute storage d = _disputes[disputeID];
        if (d.status != DisputeStatus.Waiting || d.panel.length == 0) revert NotDrawn();
        if (!_onPanel(d, msg.sender)) revert NotOnPanel();
        if (block.timestamp <= d.commitBy && !_allCommitted(d, disputeID)) revert TooEarly();
        if (block.timestamp > d.revealBy) revert TooLate();
        if (vote > d.choices) revert InvalidVote();
        if (revealedVote[disputeID][msg.sender] != 0) revert AlreadyRevealed();
        if (keccak256(abi.encode(disputeID, vote, salt, msg.sender)) != commitments[disputeID][msg.sender]) revert BadReveal();
        revealedVote[disputeID][msg.sender] = vote + 1;
        d.revealed++;
        emit VoteRevealed(disputeID, msg.sender, vote);
    }

    /// @notice Tally and deliver the ruling. Anyone may call after the reveal window, or as soon as
    ///         every juror has revealed.
    function execute(uint256 disputeID) external nonReentrant {
        Dispute storage d = _disputes[disputeID];
        if (d.status != DisputeStatus.Waiting || d.panel.length == 0) revert NotDrawn();
        if (block.timestamp <= d.revealBy && d.revealed < d.panel.length) revert TooEarly();

        uint256 m = d.panel.length;
        uint256[] memory count = new uint256[](d.choices + 1);
        for (uint256 i; i < m; ++i) {
            uint8 rv = revealedVote[disputeID][d.panel[i]];
            if (rv != 0) count[rv - 1]++;
        }
        uint256 ruling;
        bool supermajority;
        uint256 need = _supermajority(m);
        for (uint256 v; v <= d.choices; ++v) {
            if (count[v] >= need) {
                ruling = v;
                supermajority = true;
                break;
            }
        }
        // No supermajority: refuse to arbitrate (EvalBounty splits) and slash nobody.
        if (!supermajority) ruling = 0;

        // Payouts: fee (+ slashed stake) shared by coherent jurors; without a supermajority the fee is
        // shared by everyone who revealed. Non-revealers never earn.
        uint256 slashedTotal;
        uint8 coherent;
        if (supermajority) {
            for (uint256 i; i < m; ++i) {
                address j = d.panel[i];
                bool ok = revealedVote[disputeID][j] == ruling + 1;
                if (ok) {
                    coherent++;
                } else {
                    uint256 slash = (jurorInfo[j].stake * slashBps) / BPS;
                    jurorInfo[j].stake -= slash;
                    totalStake -= slash;
                    slashedTotal += slash;
                    emit JurorSlashed(disputeID, j, slash);
                }
            }
            uint256 pot = d.fee + slashedTotal;
            uint256 share = coherent == 0 ? 0 : pot / coherent;
            for (uint256 i; i < m; ++i) {
                address j = d.panel[i];
                if (revealedVote[disputeID][j] == ruling + 1) pending[j] += share;
            }
        } else if (d.revealed > 0) {
            uint256 share = d.fee / d.revealed;
            for (uint256 i; i < m; ++i) {
                address j = d.panel[i];
                if (revealedVote[disputeID][j] != 0) {
                    pending[j] += share;
                    coherent++;
                }
            }
        } else {
            pending[owner()] += d.fee; // nobody showed up; fee to treasury rather than stuck
        }
        for (uint256 i; i < m; ++i) jurorInfo[d.panel[i]].activePanels--;

        d.ruling = ruling;
        d.status = DisputeStatus.Solved;
        emit Executed(disputeID, ruling, coherent, d.revealed, slashedTotal);

        // Deliver to the arbitrable. It may already have finalized (ruling deadline passed); the
        // jurors are still paid and the outcome is recorded here.
        try d.arbitrable.rule(disputeID, ruling) {}
        catch (bytes memory reason) {
            emit RulingNotDelivered(disputeID, ruling, reason);
        }
    }

    // ------------------------------------------------------------------ payouts / admin

    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pending[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function setParams(
        uint256 minStake_,
        uint256 jurorFee_,
        uint8 panelSize_,
        uint64 commitWindow_,
        uint64 revealWindow_,
        uint16 slashBps_,
        uint16 lambda_
    ) external onlyOwner {
        _setParams(minStake_, jurorFee_, panelSize_, commitWindow_, revealWindow_, slashBps_, lambda_);
    }

    // ------------------------------------------------------------------ views

    function getDispute(uint256 disputeID)
        external
        view
        returns (
            IArbitrable arbitrable,
            uint256 choices,
            uint256 ruling,
            DisputeStatus status,
            uint256 sortitionBlock,
            address[] memory panel,
            uint64 commitBy,
            uint64 revealBy,
            uint256 fee,
            uint8 revealed,
            bytes32 keysHash
        )
    {
        Dispute storage d = _disputes[disputeID];
        return (d.arbitrable, d.choices, d.ruling, d.status, d.sortitionBlock, d.panel, d.commitBy, d.revealBy, d.fee, d.revealed, d.keysHash);
    }

    function panelOf(uint256 disputeID) external view returns (address[] memory) {
        return _disputes[disputeID].panel;
    }

    function jurorCount() external view returns (uint256) {
        return jurorList.length;
    }

    // ------------------------------------------------------------------ internals

    function _supermajority(uint256 m) internal pure returns (uint256) {
        return (2 * m + 2) / 3; // ceil(2m/3)
    }

    function _onPanel(Dispute storage d, address a) internal view returns (bool) {
        for (uint256 i; i < d.panel.length; ++i) {
            if (d.panel[i] == a) return true;
        }
        return false;
    }

    function _allCommitted(Dispute storage d, uint256 disputeID) internal view returns (bool) {
        for (uint256 i; i < d.panel.length; ++i) {
            if (commitments[disputeID][d.panel[i]] == bytes32(0)) return false;
        }
        return true;
    }

    function _setParams(
        uint256 minStake_,
        uint256 jurorFee_,
        uint8 panelSize_,
        uint64 commitWindow_,
        uint64 revealWindow_,
        uint16 slashBps_,
        uint16 lambda_
    ) internal {
        if (panelSize_ == 0 || slashBps_ > BPS || lambda_ == 0 || minStake_ == 0) revert BadParams();
        minStake = minStake_;
        jurorFee = jurorFee_;
        panelSize = panelSize_;
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
        slashBps = slashBps_;
        lambda = lambda_;
        emit ParamsUpdated(minStake_, jurorFee_, panelSize_, commitWindow_, revealWindow_, slashBps_, lambda_);
    }
}
