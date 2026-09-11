// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EvalBounty} from "../src/EvalBounty.sol";
import {CentralizedArbitrator} from "../src/CentralizedArbitrator.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {IArbitrable} from "../src/interfaces/IArbitrable.sol";
import {TestMerkle} from "./TestMerkle.sol";

contract RevertingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

contract Reenterer {
    EvalBounty immutable m;
    uint256 public reentered;

    constructor(EvalBounty m_) {
        m = m_;
    }

    receive() external payable {
        // try to drain again while the first withdraw is mid-flight
        try m.withdraw() {
            reentered++;
        } catch {}
    }

    function go() external {
        m.withdraw();
    }
}

contract EvalBountyTest is Test {
    EvalBounty m;
    CentralizedArbitrator arb;

    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");
    address seller2 = makeAddr("seller2");
    address arbiter = makeAddr("arbiter");
    address treasury = makeAddr("treasury");
    address rando = makeAddr("rando");

    uint256 constant REWARD = 1 ether;
    uint256 constant BOND = 0.5 ether; // 50% of reward
    uint256 constant ARB_PRICE = 0.01 ether;
    uint256 constant FEE = 0.02 ether; // 2%
    uint32 constant N = 8;
    uint8 constant K = 3;

    bytes[] tasks;
    bytes32[] leaves;
    bytes32 taskRoot;

    function setUp() public {
        arb = new CentralizedArbitrator(arbiter, ARB_PRICE, bytes32(uint256(1)));
        m = new EvalBounty(
            IArbitrator(address(arb)),
            treasury,
            EvalBounty.Windows({approve: 30 minutes, deliver: 30 minutes, verify: 60 minutes, rule: 60 minutes}),
            "ipfs://meta-evidence"
        );
        vm.deal(buyer, 100 ether);
        vm.deal(seller, 100 ether);
        vm.deal(seller2, 100 ether);
        vm.deal(rando, 100 ether);
        for (uint256 i; i < N; ++i) {
            tasks.push(abi.encodePacked('{"index":', vm.toString(i), ',"prompt":"task ', vm.toString(i), '"}'));
            leaves.push(TestMerkle.leaf(i, tasks[i]));
        }
        taskRoot = TestMerkle.root(leaves);
        vm.roll(100);
        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------ helpers

    function _spec() internal pure returns (EvalBounty.Spec memory s) {
        s = EvalBounty.Spec({
            domainTag: "exact-answer-reasoning",
            taskCount: N,
            sampleSize: K,
            weakModel: "mock-weak",
            strongModel: "mock-strong",
            weakMaxBps: 3500,
            strongMinBps: 6500,
            nullMaxBps: 500,
            runs: 1,
            toleranceBps: 1000,
            runParamsHash: keccak256("runparams")
        });
    }

    function _create() internal returns (uint256 id) {
        vm.prank(buyer);
        id = m.createBounty{value: REWARD}(_spec(), bytes32(uint256(0xabc)));
    }

    function _commit(uint256 id, address s) internal {
        vm.prank(s);
        m.commit{value: BOND}(id, taskRoot, keccak256("bundle"));
    }

    function _reveal(uint256 id, address s) internal {
        EvalBounty.Bounty memory b = m.getBounty(id);
        vm.roll(b.sampleBlock + 1);
        uint256[] memory idx = m.sampleIndices(id);
        bytes[] memory t = new bytes[](idx.length);
        bytes32[][] memory p = new bytes32[][](idx.length);
        for (uint256 j; j < idx.length; ++j) {
            t[j] = tasks[idx[j]];
            p[j] = TestMerkle.proof(leaves, idx[j]);
        }
        vm.prank(s);
        m.revealSample(id, t, p);
    }

    function _toApproved(uint256 id) internal {
        _commit(id, seller);
        _reveal(id, seller);
        vm.prank(buyer);
        m.approveSample(id);
    }

    function _toDelivered(uint256 id) internal {
        _toApproved(id);
        vm.prank(seller);
        m.deliver(id, hex"deadbeef");
    }

    function _toDisputed(uint256 id) internal returns (uint256 disputeId) {
        _toDelivered(id);
        vm.prank(buyer);
        m.dispute{value: BOND + ARB_PRICE}(id, EvalBounty.DisputeKind.ClaimsFailed, hex"01");
        disputeId = m.getBounty(id).disputeId;
    }

    function _status(uint256 id) internal view returns (EvalBounty.Status) {
        return m.getBounty(id).status;
    }

    // ------------------------------------------------------------ 1. happy path

    function test_HappyPath_SettlesToSellerWithFee() public {
        uint256 id = _create();
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Open));
        assertEq(address(m).balance, REWARD);

        _commit(id, seller);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Committed));
        assertEq(m.getBounty(id).sampleBlock, block.number + 1);

        _reveal(id, seller);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Sampled));

        vm.prank(buyer);
        m.approveSample(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Approved));

        vm.prank(seller);
        m.deliver(id, hex"c0ffee");
        assertEq(m.getBounty(id).ciphertextHash, keccak256(hex"c0ffee"));

        vm.prank(buyer);
        m.accept(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Settled));

        assertEq(m.pending(seller), REWARD - FEE + BOND);
        assertEq(m.pending(treasury), FEE);
        assertEq(m.pending(buyer), 0);

        uint256 before = seller.balance;
        vm.prank(seller);
        m.withdraw();
        assertEq(seller.balance - before, REWARD - FEE + BOND);
        vm.prank(treasury);
        m.withdraw();
        assertEq(treasury.balance, FEE);
        assertEq(address(m).balance, 0);

        (,,,,, uint32 settled,,, uint256 volume) = m.sellerRep(seller);
        assertEq(settled, 1);
        assertEq(volume, REWARD);
        (, uint32 bsettled,,) = m.buyerRep(buyer);
        assertEq(bsettled, 1);
    }

    // ------------------------------------------------------------ 2. reveal checks

    function test_RevealBeforeSampleBlockPassedReverts() public {
        uint256 id = _create();
        _commit(id, seller);
        // still in the commit block: sample block is the next one
        vm.expectRevert(EvalBounty.TooEarly.selector);
        m.sampleIndices(id);
        vm.roll(block.number + 1); // == sampleBlock, still not usable
        vm.expectRevert(EvalBounty.TooEarly.selector);
        m.sampleIndices(id);
    }

    function test_RevealWithBadProofReverts() public {
        uint256 id = _create();
        _commit(id, seller);
        vm.roll(block.number + 2);
        uint256[] memory idx = m.sampleIndices(id);
        bytes[] memory t = new bytes[](idx.length);
        bytes32[][] memory p = new bytes32[][](idx.length);
        for (uint256 j; j < idx.length; ++j) {
            t[j] = tasks[idx[j]];
            p[j] = TestMerkle.proof(leaves, idx[j]);
        }
        // swap in a task that is not the sampled one (cherry-pick attempt)
        t[0] = tasks[(idx[0] + 1) % N];
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.InvalidProof.selector, idx[0]));
        m.revealSample(id, t, p);
    }

    function test_RevealWrongLengthReverts() public {
        uint256 id = _create();
        _commit(id, seller);
        vm.roll(block.number + 2);
        bytes[] memory t = new bytes[](1);
        bytes32[][] memory p = new bytes32[][](1);
        vm.prank(seller);
        vm.expectRevert(EvalBounty.LengthMismatch.selector);
        m.revealSample(id, t, p);
    }

    function test_RevealAfterBlockhashExpiredReverts() public {
        uint256 id = _create();
        _commit(id, seller);
        uint256 sb = m.getBounty(id).sampleBlock;
        vm.roll(sb + 300);
        vm.setBlockhash(sb, bytes32(0)); // emulate EVM: blockhash older than 256 blocks is zero
        vm.expectRevert(EvalBounty.SampleExpired.selector);
        m.sampleIndices(id);
    }

    function test_SampleIndices_DistinctAndInRange(bytes32 bh, uint256 id, uint32 n, uint8 k) public view {
        n = uint32(bound(n, 1, 10_000));
        k = uint8(bound(k, 1, n < 16 ? n : 16));
        uint256[] memory idx = m.sampleIndicesFor(bh, id, n, k);
        assertEq(idx.length, k);
        for (uint256 i; i < k; ++i) {
            assertLt(idx[i], n);
            for (uint256 j = i + 1; j < k; ++j) {
                assertTrue(idx[i] != idx[j], "duplicate index");
            }
        }
    }

    function test_SampleIndices_Deterministic() public view {
        uint256[] memory a = m.sampleIndicesFor(bytes32(uint256(42)), 7, 30, 4);
        uint256[] memory b = m.sampleIndicesFor(bytes32(uint256(42)), 7, 30, 4);
        assertEq(a.length, 4);
        for (uint256 i; i < 4; ++i) assertEq(a[i], b[i]);
    }

    // ------------------------------------------------------------ 3. reject reopens

    function test_RejectSampleReopensAndReturnsBond_SecondSellerCanCommit() public {
        uint256 id = _create();
        _commit(id, seller);
        _reveal(id, seller);
        vm.prank(buyer);
        m.rejectSample(id, "prompts are unanswerable");
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Open));
        assertEq(m.pending(seller), BOND);
        assertEq(m.getBounty(id).seller, address(0));
        (, uint32 rejected,,,,,,,) = m.sellerRep(seller);
        assertEq(rejected, 1);

        _commit(id, seller2);
        assertEq(m.getBounty(id).seller, seller2);
        _reveal(id, seller2);
        vm.prank(buyer);
        m.approveSample(id);
        vm.prank(seller2);
        m.deliver(id, hex"01");
        vm.prank(buyer);
        m.accept(id);
        assertEq(m.pending(seller2), REWARD - FEE + BOND);
    }

    // ------------------------------------------------------------ 4/5. timeouts

    function test_DeliverTimeout_SlashesBondToBuyerAndReopens() public {
        uint256 id = _create();
        _toApproved(id);
        vm.expectRevert(EvalBounty.TooEarly.selector);
        m.finalize(id);
        vm.warp(m.getBounty(id).deliverBy + 1);
        vm.prank(rando);
        m.finalize(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Open));
        assertEq(m.pending(buyer), BOND);
        assertEq(m.pending(seller), 0);
        (,,,, uint32 timeouts,,,,) = m.sellerRep(seller);
        assertEq(timeouts, 1);
        // reward still escrowed for the next seller
        assertEq(address(m).balance, REWARD + BOND);
    }

    function test_VerifyTimeout_SettlesToSeller() public {
        uint256 id = _create();
        _toDelivered(id);
        vm.warp(m.getBounty(id).verifyBy + 1);
        // buyer can no longer dispute after reading for free
        vm.prank(buyer);
        vm.expectRevert(EvalBounty.TooLate.selector);
        m.dispute{value: BOND + ARB_PRICE}(id, EvalBounty.DisputeKind.ClaimsFailed, "");
        m.finalize(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Settled));
        assertEq(m.pending(seller), REWARD - FEE + BOND);
    }

    function test_BuyerIgnoresSample_SellerRecoversBondAndBountyReopens() public {
        uint256 id = _create();
        _commit(id, seller);
        _reveal(id, seller);
        vm.prank(seller);
        vm.expectRevert(EvalBounty.TooEarly.selector);
        m.withdrawCommit(id);
        vm.warp(m.getBounty(id).approveBy + 1);
        vm.prank(seller);
        m.withdrawCommit(id);
        assertEq(m.pending(seller), BOND);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Open));
    }

    function test_SellerNeverReveals_FinalizeAfter256BlocksPenalises() public {
        uint256 id = _create();
        _commit(id, seller);
        uint256 sb = m.getBounty(id).sampleBlock;
        vm.roll(sb + 256);
        vm.expectRevert(EvalBounty.TooEarly.selector);
        m.finalize(id);
        vm.roll(sb + 257);
        m.finalize(id);
        uint256 penalty = BOND / 10;
        assertEq(m.pending(buyer), penalty);
        assertEq(m.pending(seller), BOND - penalty);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Open));
    }

    // ------------------------------------------------------------ withdrawCommit / grinding deterrent

    function test_WithdrawCommit_FreeBeforeSampleKnown_PenalisedAfter() public {
        uint256 id = _create();
        _commit(id, seller);
        vm.prank(seller);
        m.withdrawCommit(id); // sample block not yet mined: free
        assertEq(m.pending(seller), BOND);
        assertEq(m.pending(buyer), 0);

        _commit(id, seller2);
        vm.roll(block.number + 2); // sample is now knowable
        vm.prank(seller2);
        m.withdrawCommit(id);
        assertEq(m.pending(seller2), BOND - BOND / 10);
        assertEq(m.pending(buyer), BOND / 10);
        (,, uint32 abandoned,,,,,,) = m.sellerRep(seller2);
        assertEq(abandoned, 1);
    }

    // ------------------------------------------------------------ 6. disputes

    function test_Dispute_SellerWins() public {
        uint256 id = _create();
        uint256 disputeId = _toDisputed(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Disputed));
        assertEq(address(arb).balance, ARB_PRICE);

        vm.prank(arbiter);
        vm.expectEmit(true, true, false, true, address(m));
        emit IArbitrable.Ruling(IArbitrator(address(arb)), disputeId, 1);
        arb.giveRuling(disputeId, 1, "transcript:0xabc");

        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Settled));
        assertEq(m.pending(seller), REWARD - FEE + BOND + BOND); // + buyer's dispute bond
        assertEq(m.pending(treasury), FEE);
        assertEq(m.pending(buyer), 0);
        (,,,,,, uint32 won,,) = m.sellerRep(seller);
        assertEq(won, 1);
        (,,, uint32 lost) = m.buyerRep(buyer);
        assertEq(lost, 1);
    }

    function test_Dispute_BuyerWins() public {
        uint256 id = _create();
        uint256 disputeId = _toDisputed(id);
        vm.prank(arbiter);
        arb.giveRuling(disputeId, 2, "transcript:0xdef");
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Refunded));
        assertEq(m.pending(buyer), REWARD + BOND + BOND); // reward + own dispute bond + seller's bond
        assertEq(m.pending(seller), 0);
        assertEq(m.pending(treasury), 0);
        (,,,,,,, uint32 lost,) = m.sellerRep(seller);
        assertEq(lost, 1);
        // contract holds nothing it does not owe
        assertEq(address(m).balance, m.pending(buyer));
    }

    function test_Dispute_ArbitratorRefuses_Splits() public {
        uint256 id = _create();
        uint256 disputeId = _toDisputed(id);
        vm.prank(arbiter);
        arb.giveRuling(disputeId, 0, "refused");
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Refunded));
        assertEq(m.pending(buyer), REWARD / 2 + BOND);
        assertEq(m.pending(seller), REWARD / 2 + BOND);
    }

    function test_Dispute_WrongValueReverts() public {
        uint256 id = _create();
        _toDelivered(id);
        vm.prank(buyer);
        vm.expectRevert(EvalBounty.BadValue.selector);
        m.dispute{value: BOND}(id, EvalBounty.DisputeKind.BadDelivery, "");
        assertEq(m.disputeCost(id), BOND + ARB_PRICE);
    }

    function test_Dispute_CannotBeRuledTwice() public {
        uint256 id = _create();
        uint256 disputeId = _toDisputed(id);
        vm.prank(arbiter);
        arb.giveRuling(disputeId, 1, "");
        vm.prank(arbiter);
        vm.expectRevert(CentralizedArbitrator.AlreadyRuled.selector);
        arb.giveRuling(disputeId, 2, "");
    }

    // ------------------------------------------------------------ 7. ruling timeout

    function test_RulingTimeout_SplitsAndReturnsBonds() public {
        uint256 id = _create();
        _toDisputed(id);
        vm.expectRevert(EvalBounty.TooEarly.selector);
        m.finalize(id);
        vm.warp(m.getBounty(id).ruleBy + 1);
        m.finalize(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Refunded));
        assertEq(m.pending(buyer), REWARD / 2 + BOND);
        assertEq(m.pending(seller), REWARD - REWARD / 2 + BOND);
        // a late ruling can no longer move funds
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.WrongStatus.selector, EvalBounty.Status.Refunded));
        arb.giveRuling(0, 2, "");
    }

    // ------------------------------------------------------------ 8. pull payments / reentrancy

    function test_Withdraw_RevertingRecipientDoesNotBlockOthers() public {
        RevertingReceiver bad = new RevertingReceiver();
        vm.deal(address(bad), 10 ether);
        vm.prank(address(bad));
        uint256 id = m.createBounty{value: REWARD}(_spec(), bytes32(uint256(1)));
        vm.prank(address(bad));
        m.cancelBounty(id);
        assertEq(m.pending(address(bad)), REWARD);
        vm.prank(address(bad));
        vm.expectRevert(EvalBounty.TransferFailed.selector);
        m.withdraw();
        // funds stay credited, and an unrelated settlement is unaffected
        assertEq(m.pending(address(bad)), REWARD);
        uint256 id2 = _create();
        _toDelivered(id2);
        vm.prank(buyer);
        m.accept(id2);
        vm.prank(seller);
        m.withdraw();
        assertEq(seller.balance, 100 ether - BOND + REWARD - FEE + BOND);
    }

    function test_Withdraw_ReentrancyGetsNothingExtra() public {
        Reenterer r = new Reenterer(m);
        vm.deal(address(r), 10 ether);
        vm.prank(address(r));
        uint256 id = m.createBounty{value: REWARD}(_spec(), bytes32(uint256(1)));
        vm.prank(address(r));
        m.cancelBounty(id);
        r.go();
        assertEq(address(r).balance, 10 ether);
        assertEq(m.pending(address(r)), 0);
        assertEq(r.reentered(), 0);
    }

    function test_Withdraw_NothingReverts() public {
        vm.prank(rando);
        vm.expectRevert(EvalBounty.NothingToWithdraw.selector);
        m.withdraw();
    }

    // ------------------------------------------------------------ 9. access control / state machine

    function test_OnlyBuyerCanApproveRejectAcceptDisputeCancel() public {
        uint256 id = _create();
        vm.prank(rando);
        vm.expectRevert(EvalBounty.NotBuyer.selector);
        m.cancelBounty(id);
        _commit(id, seller);
        _reveal(id, seller);
        vm.prank(seller);
        vm.expectRevert(EvalBounty.NotBuyer.selector);
        m.approveSample(id);
        vm.prank(seller);
        vm.expectRevert(EvalBounty.NotBuyer.selector);
        m.rejectSample(id, "");
        vm.prank(buyer);
        m.approveSample(id);
        vm.prank(seller);
        m.deliver(id, hex"01");
        vm.prank(seller);
        vm.expectRevert(EvalBounty.NotBuyer.selector);
        m.accept(id);
        vm.prank(seller);
        vm.expectRevert(EvalBounty.NotBuyer.selector);
        m.dispute{value: BOND + ARB_PRICE}(id, EvalBounty.DisputeKind.BadDelivery, "");
    }

    function test_OnlySellerCanRevealDeliverWithdrawCommit() public {
        uint256 id = _create();
        _commit(id, seller);
        vm.roll(block.number + 2);
        bytes[] memory t = new bytes[](K);
        bytes32[][] memory p = new bytes32[][](K);
        vm.prank(rando);
        vm.expectRevert(EvalBounty.NotSeller.selector);
        m.revealSample(id, t, p);
        vm.prank(rando);
        vm.expectRevert(EvalBounty.NotSeller.selector);
        m.withdrawCommit(id);
        _reveal(id, seller);
        vm.prank(buyer);
        m.approveSample(id);
        vm.prank(rando);
        vm.expectRevert(EvalBounty.NotSeller.selector);
        m.deliver(id, hex"01");
    }

    function test_OnlyArbitratorCanRule() public {
        uint256 id = _create();
        uint256 disputeId = _toDisputed(id);
        vm.prank(rando);
        vm.expectRevert(EvalBounty.NotArbitrator.selector);
        m.rule(disputeId, 1);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), rando));
        arb.giveRuling(disputeId, 1, "");
    }

    function test_WrongStateCallsRevert() public {
        uint256 id = _create();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.WrongStatus.selector, EvalBounty.Status.Open));
        m.approveSample(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.WrongStatus.selector, EvalBounty.Status.Open));
        m.accept(id);
        _commit(id, seller);
        vm.prank(seller2);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.WrongStatus.selector, EvalBounty.Status.Committed));
        m.commit{value: BOND}(id, taskRoot, keccak256("x"));
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.WrongStatus.selector, EvalBounty.Status.Committed));
        m.deliver(id, hex"01");
        vm.expectRevert(EvalBounty.UnknownBounty.selector);
        m.getBounty(99);
    }

    function test_CommitRequiresMinimumBond() public {
        uint256 id = _create();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.InsufficientBond.selector, BOND));
        m.commit{value: BOND - 1}(id, taskRoot, keccak256("bundle"));
        assertEq(m.minSellerBond(id), BOND);
    }

    function test_CreateBounty_ValidatesSpec() public {
        EvalBounty.Spec memory s = _spec();
        s.sampleSize = 0;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.InvalidSpec.selector, "sampleSize must be 1..16"));
        m.createBounty{value: 1 ether}(s, bytes32(uint256(1)));
        s = _spec();
        s.strongMinBps = s.weakMaxBps;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.InvalidSpec.selector, "strongMin must exceed weakMax"));
        m.createBounty{value: 1 ether}(s, bytes32(uint256(1)));
        vm.prank(buyer);
        vm.expectRevert(EvalBounty.BadValue.selector);
        m.createBounty{value: 0}(_spec(), bytes32(uint256(1)));
    }

    function test_CancelBounty_RefundsBuyer() public {
        uint256 id = _create();
        vm.prank(buyer);
        m.cancelBounty(id);
        assertEq(uint8(_status(id)), uint8(EvalBounty.Status.Cancelled));
        assertEq(m.pending(buyer), REWARD);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EvalBounty.WrongStatus.selector, EvalBounty.Status.Cancelled));
        m.commit{value: BOND}(id, taskRoot, keccak256("bundle"));
    }

    function test_Admin_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), rando));
        m.setParams(100, 5000, 5000, 1000);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), rando));
        m.setTreasury(rando);
        m.setParams(100, 2000, 3000, 500);
        assertEq(m.feeBps(), 100);
        vm.expectRevert(EvalBounty.BadValue.selector);
        m.setParams(1001, 0, 0, 0);
    }

    // ------------------------------------------------------------ solvency invariant on a full run

    function test_ContractNeverOwesMoreThanItHolds() public {
        uint256 a = _create();
        uint256 b = _create();
        uint256 c = _create();
        _toDelivered(a);
        vm.prank(buyer);
        m.accept(a);
        uint256 d = _toDisputed(b);
        vm.prank(arbiter);
        arb.giveRuling(d, 2, "");
        _commit(c, seller2);
        _reveal(c, seller2);
        vm.prank(buyer);
        m.rejectSample(c, "meh");
        uint256 owed = m.pending(buyer) + m.pending(seller) + m.pending(seller2) + m.pending(treasury) + REWARD; // c still open
        assertEq(address(m).balance, owed);
    }
}
