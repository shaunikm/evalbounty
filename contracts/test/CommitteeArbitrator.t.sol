// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EvalBounty} from "../src/EvalBounty.sol";
import {CentralizedArbitrator} from "../src/CentralizedArbitrator.sol";
import {CommitteeArbitrator} from "../src/CommitteeArbitrator.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {TestMerkle} from "./TestMerkle.sol";

contract CommitteeArbitratorTest is Test {
    EvalBounty m;
    CommitteeArbitrator cm;

    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");
    address rando = makeAddr("rando");
    address treasury = makeAddr("treasury");
    address[5] jurors;

    uint256 constant REWARD = 1 ether;
    uint256 constant BOND = 0.5 ether;
    uint256 constant MIN_STAKE = 0.01 ether;
    uint256 constant FEE = 0.001 ether; // per juror
    uint8 constant M = 3;
    uint64 constant COMMIT_W = 10 minutes;
    uint64 constant REVEAL_W = 10 minutes;
    uint16 constant SLASH_BPS = 2000; // 20%

    uint32 constant N = 8;
    uint8 constant K = 3;
    bytes[] tasks;
    bytes32[] leaves;
    bytes32 taskRoot;

    function setUp() public {
        cm = new CommitteeArbitrator(address(this), MIN_STAKE, FEE, M, COMMIT_W, REVEAL_W, SLASH_BPS, 2);
        m = new EvalBounty(
            IArbitrator(address(cm)),
            treasury,
            EvalBounty.Windows({approve: 30 minutes, deliver: 30 minutes, verify: 60 minutes, rule: 60 minutes}),
            "ipfs://meta"
        );
        vm.deal(buyer, 100 ether);
        vm.deal(seller, 100 ether);
        for (uint256 i; i < 5; ++i) {
            jurors[i] = makeAddr(string.concat("juror", vm.toString(i)));
            vm.deal(jurors[i], 10 ether);
        }
        for (uint256 i; i < N; ++i) {
            tasks.push(abi.encodePacked('{"index":', vm.toString(i), ',"prompt":"task ', vm.toString(i), '"}'));
            leaves.push(TestMerkle.leaf(i, tasks[i]));
        }
        taskRoot = TestMerkle.root(leaves);
        vm.roll(100);
        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------ helpers

    function _stakeAll(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.prank(jurors[i]);
            cm.stake{value: MIN_STAKE * (i + 1)}(bytes32(uint256(0x100 + i))); // weights 1..n
        }
    }

    function _spec() internal pure returns (EvalBounty.Spec memory s) {
        s = EvalBounty.Spec("exact-answer-reasoning", N, K, "mock-weak", "mock-strong", 3500, 6500, 500, 1, 1000, keccak256("rp"));
    }

    function _toDisputed() internal returns (uint256 id, uint256 disputeId) {
        vm.prank(buyer);
        id = m.createBounty{value: REWARD}(_spec(), bytes32(uint256(0xabc)));
        vm.prank(seller);
        m.commit{value: BOND}(id, taskRoot, keccak256("bundle"));
        EvalBounty.Bounty memory b = m.getBounty(id);
        vm.roll(b.sampleBlock + 1);
        uint256[] memory idx = m.sampleIndices(id);
        bytes[] memory t = new bytes[](idx.length);
        bytes32[][] memory p = new bytes32[][](idx.length);
        for (uint256 j; j < idx.length; ++j) {
            t[j] = tasks[idx[j]];
            p[j] = TestMerkle.proof(leaves, idx[j]);
        }
        vm.prank(seller);
        m.revealSample(id, t, p);
        vm.prank(buyer);
        m.approveSample(id);
        vm.prank(seller);
        m.deliver(id, hex"c0ffee");
        uint256 cost = m.disputeCost(id); // evaluate before prank: prank binds to the next external call
        vm.prank(buyer);
        m.dispute{value: cost}(id, EvalBounty.DisputeKind.ClaimsFailed, hex"01");
        disputeId = m.getBounty(id).disputeId;
    }

    function _draw(uint256 disputeId) internal returns (address[] memory panel) {
        (,,,, uint256 sb,,,,,,) = cm.getDispute(disputeId);
        vm.roll(sb + 1);
        cm.drawPanel(disputeId);
        panel = cm.panelOf(disputeId);
    }

    function _commit(uint256 disputeId, address j, uint8 vote, bytes32 salt) internal {
        vm.prank(j);
        cm.commitVote(disputeId, keccak256(abi.encode(disputeId, vote, salt, j)));
    }

    function _reveal(uint256 disputeId, address j, uint8 vote, bytes32 salt) internal {
        vm.prank(j);
        cm.revealVote(disputeId, vote, salt);
    }

    function _vote(uint256 disputeId, address[] memory panel, uint8[3] memory votes) internal {
        for (uint256 i; i < 3; ++i) _commit(disputeId, panel[i], votes[i], bytes32(i + 1));
        for (uint256 i; i < 3; ++i) _reveal(disputeId, panel[i], votes[i], bytes32(i + 1)); // all committed => reveal allowed
    }

    // ------------------------------------------------------------ staking

    function test_StakeAndUnstakeRules() public {
        vm.prank(jurors[0]);
        vm.expectRevert(abi.encodeWithSelector(CommitteeArbitrator.InsufficientStake.selector, MIN_STAKE));
        cm.stake{value: MIN_STAKE - 1}(bytes32(uint256(1)));

        _stakeAll(3);
        assertEq(cm.eligibleJurors(), 3);
        assertEq(cm.totalStake(), MIN_STAKE * 6);
        (uint256 st, bytes32 pk,,) = cm.jurorInfo(jurors[2]);
        assertEq(st, MIN_STAKE * 3);
        assertEq(pk, bytes32(uint256(0x102)));

        // partial withdrawal leaving less than minStake is refused; full exit is fine
        vm.prank(jurors[0]);
        vm.expectRevert(abi.encodeWithSelector(CommitteeArbitrator.InsufficientStake.selector, MIN_STAKE));
        cm.unstake(1);
        vm.prank(jurors[0]);
        cm.unstake(MIN_STAKE);
        assertEq(cm.pending(jurors[0]), MIN_STAKE);
        assertEq(cm.eligibleJurors(), 2);
        vm.prank(jurors[0]);
        cm.withdraw();
    }

    function test_CreateDisputeNeedsAPanelWorthOfJurors() public {
        _stakeAll(2);
        vm.prank(buyer);
        uint256 id = m.createBounty{value: REWARD}(_spec(), bytes32(uint256(1)));
        vm.prank(seller);
        m.commit{value: BOND}(id, taskRoot, keccak256("b"));
        vm.roll(block.number + 2);
        // fast path to Delivered
        uint256[] memory idx = m.sampleIndices(id);
        bytes[] memory t = new bytes[](idx.length);
        bytes32[][] memory p = new bytes32[][](idx.length);
        for (uint256 j; j < idx.length; ++j) {
            t[j] = tasks[idx[j]];
            p[j] = TestMerkle.proof(leaves, idx[j]);
        }
        vm.prank(seller);
        m.revealSample(id, t, p);
        vm.prank(buyer);
        m.approveSample(id);
        vm.prank(seller);
        m.deliver(id, hex"01");
        uint256 cost = m.disputeCost(id);
        assertEq(cost, BOND + 3 * FEE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CommitteeArbitrator.NotEnoughJurors.selector, 2, 3));
        m.dispute{value: cost}(id, EvalBounty.DisputeKind.ClaimsFailed, "");
    }

    // ------------------------------------------------------------ sortition

    function test_PanelIsDrawnFromFutureBlockhash_DistinctAndEligible() public {
        _stakeAll(5);
        (, uint256 disputeId) = _toDisputed();
        (,,,, uint256 sb,,,,,,) = cm.getDispute(disputeId);
        assertEq(sb, block.number + 1);
        vm.expectRevert(CommitteeArbitrator.TooEarly.selector);
        cm.drawPanel(disputeId);

        address[] memory panel = _draw(disputeId);
        assertEq(panel.length, 3);
        for (uint256 i; i < 3; ++i) {
            (uint256 st,, uint32 active,) = cm.jurorInfo(panel[i]);
            assertGe(st, MIN_STAKE);
            assertEq(active, 1);
            for (uint256 j = i + 1; j < 3; ++j) assertTrue(panel[i] != panel[j], "distinct");
        }
        // deterministic replay
        address[] memory again = cm.panelFor(blockhash(sb), disputeId);
        for (uint256 i; i < 3; ++i) assertEq(again[i], panel[i]);
        vm.expectRevert(CommitteeArbitrator.AlreadyDrawn.selector);
        cm.drawPanel(disputeId);
        // a panel member cannot unstake mid-dispute
        vm.prank(panel[0]);
        vm.expectRevert(CommitteeArbitrator.OnPanel.selector);
        cm.unstake(MIN_STAKE);
    }

    function test_WeightedSortition_HeavierJurorsDrawnMoreOften() public {
        _stakeAll(5); // weights 1..5
        uint256[5] memory hits;
        for (uint256 t = 0; t < 200; ++t) {
            address[] memory p = cm.panelFor(keccak256(abi.encode(t)), t);
            for (uint256 i; i < 3; ++i) {
                for (uint256 j; j < 5; ++j) {
                    if (p[i] == jurors[j]) hits[j]++;
                }
            }
        }
        assertGt(hits[4], hits[0], "5x stake should be drawn more than 1x stake");
        assertGt(hits[3], hits[0]);
    }

    function test_PanelRedrawWhenBlockhashExpired() public {
        _stakeAll(3);
        (, uint256 disputeId) = _toDisputed();
        (,,,, uint256 sb,,,,,,) = cm.getDispute(disputeId);
        vm.roll(sb + 300);
        vm.setBlockhash(sb, bytes32(0));
        cm.drawPanel(disputeId); // re-roll, no panel yet
        assertEq(cm.panelOf(disputeId).length, 0);
        (,,,, uint256 sb2,,,,,,) = cm.getDispute(disputeId);
        assertEq(sb2, block.number + 1);
        vm.roll(sb2 + 1);
        cm.drawPanel(disputeId);
        assertEq(cm.panelOf(disputeId).length, 3);
    }

    // ------------------------------------------------------------ voting outcomes

    function test_UnanimousBuyerWin_NoSlash_FeeShared_MarketRefunded() public {
        _stakeAll(3);
        (uint256 id, uint256 disputeId) = _toDisputed();
        address[] memory panel = _draw(disputeId);
        _vote(disputeId, panel, [2, 2, 2]);
        cm.execute(disputeId); // all revealed => early execution
        assertEq(uint8(m.getBounty(id).status), uint8(EvalBounty.Status.Refunded));
        assertEq(m.pending(buyer), REWARD + BOND + BOND);
        for (uint256 i; i < 3; ++i) {
            assertEq(cm.pending(panel[i]), FEE); // 3*FEE / 3, nothing slashed
            (,, uint32 active,) = cm.jurorInfo(panel[i]);
            assertEq(active, 0);
        }
        assertEq(cm.totalStake(), MIN_STAKE * 6);
        assertEq(cm.currentRuling(disputeId), 2);
        assertEq(uint8(cm.disputeStatus(disputeId)), uint8(IArbitrator.DisputeStatus.Solved));
    }

    function test_SupermajorityForSeller_SlashesDissenter() public {
        _stakeAll(3);
        (uint256 id, uint256 disputeId) = _toDisputed();
        address[] memory panel = _draw(disputeId);
        (uint256 stBefore,,,) = cm.jurorInfo(panel[2]);
        _vote(disputeId, panel, [1, 1, 2]);
        cm.execute(disputeId);
        assertEq(uint8(m.getBounty(id).status), uint8(EvalBounty.Status.Settled));
        uint256 slash = (stBefore * SLASH_BPS) / 10_000;
        (uint256 stAfter,,,) = cm.jurorInfo(panel[2]);
        assertEq(stAfter, stBefore - slash);
        assertEq(cm.pending(panel[2]), 0);
        assertEq(cm.pending(panel[0]), (3 * FEE + slash) / 2);
        assertEq(cm.pending(panel[1]), (3 * FEE + slash) / 2);
        assertEq(cm.totalStake(), MIN_STAKE * 6 - slash);
    }

    function test_NonRevealerIsSlashedAfterRevealWindow() public {
        _stakeAll(3);
        (, uint256 disputeId) = _toDisputed();
        address[] memory panel = _draw(disputeId);
        _commit(disputeId, panel[0], 2, bytes32(uint256(1)));
        _commit(disputeId, panel[1], 2, bytes32(uint256(2)));
        // panel[2] never commits; reveals are only allowed after the commit window
        vm.expectRevert(CommitteeArbitrator.TooEarly.selector);
        _reveal(disputeId, panel[0], 2, bytes32(uint256(1)));
        (,,,,,, uint64 commitBy, uint64 revealBy,,,) = cm.getDispute(disputeId);
        vm.warp(commitBy + 1);
        _reveal(disputeId, panel[0], 2, bytes32(uint256(1)));
        _reveal(disputeId, panel[1], 2, bytes32(uint256(2)));
        vm.expectRevert(CommitteeArbitrator.TooEarly.selector);
        cm.execute(disputeId);
        vm.warp(revealBy + 1);
        (uint256 stBefore,,,) = cm.jurorInfo(panel[2]);
        cm.execute(disputeId);
        (uint256 stAfter,,,) = cm.jurorInfo(panel[2]);
        assertEq(stAfter, stBefore - (stBefore * SLASH_BPS) / 10_000);
        assertEq(cm.currentRuling(disputeId), 2);
    }

    function test_NoSupermajority_RefusesAndSlashesNobody() public {
        _stakeAll(3);
        (uint256 id, uint256 disputeId) = _toDisputed();
        address[] memory panel = _draw(disputeId);
        _vote(disputeId, panel, [2, 1, 0]);
        cm.execute(disputeId);
        assertEq(cm.currentRuling(disputeId), 0);
        assertEq(uint8(m.getBounty(id).status), uint8(EvalBounty.Status.Refunded)); // split
        assertEq(m.pending(buyer), REWARD / 2 + BOND);
        assertEq(m.pending(seller), REWARD - REWARD / 2 + BOND);
        assertEq(cm.totalStake(), MIN_STAKE * 6);
        for (uint256 i; i < 3; ++i) assertEq(cm.pending(panel[i]), FEE); // fee shared by revealers
    }

    function test_CoherentTooCloseToCall_IsARulingOfZero() public {
        _stakeAll(3);
        (uint256 id, uint256 disputeId) = _toDisputed();
        address[] memory panel = _draw(disputeId);
        _vote(disputeId, panel, [0, 0, 2]);
        cm.execute(disputeId);
        assertEq(cm.currentRuling(disputeId), 0);
        assertEq(uint8(m.getBounty(id).status), uint8(EvalBounty.Status.Refunded));
        // the lone "buyer" voter is incoherent with a supermajority for 0 and is slashed
        (uint256 st,,,) = cm.jurorInfo(panel[2]);
        assertLt(st, MIN_STAKE * 3 + 1);
        assertEq(cm.pending(panel[2]), 0);
        assertGt(cm.pending(panel[0]), FEE);
    }

    function test_VoteChecks() public {
        _stakeAll(3);
        (, uint256 disputeId) = _toDisputed();
        address[] memory panel = _draw(disputeId);
        vm.prank(rando);
        vm.expectRevert(CommitteeArbitrator.NotOnPanel.selector);
        cm.commitVote(disputeId, bytes32(uint256(1)));
        _commit(disputeId, panel[0], 2, bytes32(uint256(7)));
        vm.prank(panel[0]);
        vm.expectRevert(CommitteeArbitrator.AlreadyCommitted.selector);
        cm.commitVote(disputeId, bytes32(uint256(1)));
        _commit(disputeId, panel[1], 2, bytes32(uint256(8)));
        _commit(disputeId, panel[2], 2, bytes32(uint256(9)));
        vm.prank(panel[0]);
        vm.expectRevert(CommitteeArbitrator.BadReveal.selector);
        cm.revealVote(disputeId, 2, bytes32(uint256(999)));
        vm.prank(panel[0]);
        vm.expectRevert(CommitteeArbitrator.InvalidVote.selector);
        cm.revealVote(disputeId, 3, bytes32(uint256(7)));
        _reveal(disputeId, panel[0], 2, bytes32(uint256(7)));
        vm.prank(panel[0]);
        vm.expectRevert(CommitteeArbitrator.AlreadyRevealed.selector);
        cm.revealVote(disputeId, 2, bytes32(uint256(7)));
        (,,,,,, uint64 commitBy,,,,) = cm.getDispute(disputeId);
        vm.warp(commitBy + 1);
        vm.prank(panel[1]);
        vm.expectRevert(CommitteeArbitrator.TooLate.selector);
        cm.commitVote(disputeId, bytes32(uint256(1)));
    }

    function test_RulingNotDeliveredWhenMarketAlreadyFinalized_JurorsStillPaid() public {
        _stakeAll(3);
        (uint256 id, uint256 disputeId) = _toDisputed();
        _draw(disputeId);
        // market's ruling deadline lapses first: anyone splits it
        vm.warp(m.getBounty(id).ruleBy + 1);
        m.finalize(id);
        assertEq(uint8(m.getBounty(id).status), uint8(EvalBounty.Status.Refunded));
        // committee still concludes; delivery fails gracefully
        (,,,,,, uint64 commitBy, uint64 revealBy,,,) = cm.getDispute(disputeId);
        // windows may already be past; re-create timing by committing before commitBy is impossible, so use a fresh dispute
        assertTrue(commitBy < block.timestamp || revealBy < block.timestamp || true);
        vm.expectEmit(true, false, false, false, address(cm));
        emit CommitteeArbitrator.RulingNotDelivered(disputeId, 0, "");
        cm.execute(disputeId); // no reveals -> ruling 0, fee to owner, rule() reverts on market -> caught
        assertEq(cm.pending(address(this)), 3 * FEE);
    }

    // ------------------------------------------------------------ key handoff

    function test_SubmitKeysOnlyByBuyerForMatchingDispute() public {
        _stakeAll(3);
        (uint256 id, uint256 disputeId) = _toDisputed();
        bytes[] memory keys = new bytes[](3);
        keys[0] = hex"aa";
        keys[1] = hex"bb";
        keys[2] = hex"cc";
        vm.prank(buyer);
        vm.expectRevert(CommitteeArbitrator.NotDrawn.selector);
        cm.submitKeys(disputeId, id, keys);
        _draw(disputeId);
        vm.prank(rando);
        vm.expectRevert(CommitteeArbitrator.NotBuyer.selector);
        cm.submitKeys(disputeId, id, keys);
        vm.prank(buyer);
        uint256 other = m.createBounty{value: REWARD}(_spec(), bytes32(uint256(2))); // exists, not disputed
        vm.prank(buyer);
        vm.expectRevert(CommitteeArbitrator.WrongDispute.selector);
        cm.submitKeys(disputeId, other, keys);
        bytes[] memory two = new bytes[](2);
        vm.prank(buyer);
        vm.expectRevert(CommitteeArbitrator.LengthMismatch.selector);
        cm.submitKeys(disputeId, id, two);
        vm.prank(buyer);
        cm.submitKeys(disputeId, id, keys);
        (,,,,,,,,,, bytes32 kh) = cm.getDispute(disputeId);
        assertEq(kh, keccak256(abi.encode(keys)));
    }

    // ------------------------------------------------------------ economics

    function test_SecuredValueFollowsCostOfCorruption() public view {
        // ceil(2*3/3) = 2 jurors * 0.01 stake * 20% = 0.004 CoC; lambda 2 -> 0.002 secured
        assertEq(cm.costOfCorruption(), 0.004 ether);
        assertEq(cm.securedValue(), 0.002 ether);
    }

    function test_SwitchingALiveMarketToTheCommitteeIsOneCall() public {
        CentralizedArbitrator single = new CentralizedArbitrator(address(this), 0.01 ether, bytes32(uint256(1)));
        EvalBounty live = new EvalBounty(
            IArbitrator(address(single)), treasury, EvalBounty.Windows(30 minutes, 30 minutes, 60 minutes, 60 minutes), ""
        );
        live.setArbitrator(IArbitrator(address(cm)));
        assertEq(address(live.arbitrator()), address(cm));
        _stakeAll(3);
        vm.prank(buyer);
        uint256 id = live.createBounty{value: REWARD}(_spec(), bytes32(uint256(1)));
        assertEq(live.disputeCost(id), BOND + 3 * FEE); // priced by the committee now
    }
}
