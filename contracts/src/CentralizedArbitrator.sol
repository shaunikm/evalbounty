// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IArbitrator} from "./interfaces/IArbitrator.sol";
import {IArbitrable} from "./interfaces/IArbitrable.sol";

/// @title CentralizedArbitrator — a minimal ERC-792 arbitrator ruled by a single bonded key.
///
/// This is the demo's arbiter agent. Because EvalBounty only speaks ERC-792, swapping this for a
/// decentralised court (e.g. Kleros) is a one-address change in EvalBounty.setArbitrator.
/// Modeled on Kleros' reference CentralizedArbitrator; appeals are deliberately unsupported.
contract CentralizedArbitrator is IArbitrator, Ownable {
    struct DisputeData {
        IArbitrable arbitrable;
        uint256 choices;
        uint256 ruling;
        DisputeStatus status;
    }

    uint256 public arbitrationPrice;
    DisputeData[] public disputes;
    bytes32 public arbiterPubKey; // X25519 key buyers seal the bundle key to for ClaimsFailed disputes

    event RulingGiven(uint256 indexed disputeID, uint256 ruling, string evidence);
    event ArbitrationPriceUpdated(uint256 price);
    event ArbiterPubKeyUpdated(bytes32 pubKey);

    error InsufficientPayment(uint256 required);
    error InvalidRuling();
    error AlreadyRuled();
    error AppealsNotSupported();
    error TransferFailed();

    constructor(address owner_, uint256 arbitrationPrice_, bytes32 arbiterPubKey_) Ownable(owner_) {
        arbitrationPrice = arbitrationPrice_;
        arbiterPubKey = arbiterPubKey_;
    }

    // ---- IArbitrator ----

    function createDispute(uint256 _choices, bytes calldata) external payable override returns (uint256 disputeID) {
        if (msg.value < arbitrationPrice) revert InsufficientPayment(arbitrationPrice);
        disputeID = disputes.length;
        disputes.push(
            DisputeData({arbitrable: IArbitrable(msg.sender), choices: _choices, ruling: 0, status: DisputeStatus.Waiting})
        );
        emit DisputeCreation(disputeID, IArbitrable(msg.sender));
    }

    function arbitrationCost(bytes calldata) external view override returns (uint256) {
        return arbitrationPrice;
    }

    function appeal(uint256, bytes calldata) external payable override {
        revert AppealsNotSupported();
    }

    function appealCost(uint256, bytes calldata) external pure override returns (uint256) {
        return type(uint256).max;
    }

    function appealPeriod(uint256) external pure override returns (uint256 start, uint256 end) {
        return (0, 0);
    }

    function disputeStatus(uint256 _disputeID) external view override returns (DisputeStatus) {
        return disputes[_disputeID].status;
    }

    function currentRuling(uint256 _disputeID) external view override returns (uint256) {
        return disputes[_disputeID].ruling;
    }

    // ---- Owner (the arbiter agent) ----

    /// @notice Rule on a dispute and call back the arbitrable contract. `evidence` is a URI or
    ///         inline JSON (e.g. the keccak256 of the rerun transcript) recorded for auditability.
    function giveRuling(uint256 _disputeID, uint256 _ruling, string calldata evidence) external onlyOwner {
        DisputeData storage d = disputes[_disputeID];
        if (d.status == DisputeStatus.Solved) revert AlreadyRuled();
        if (_ruling > d.choices) revert InvalidRuling();
        d.ruling = _ruling;
        d.status = DisputeStatus.Solved;
        emit RulingGiven(_disputeID, _ruling, evidence);
        d.arbitrable.rule(_disputeID, _ruling);
    }

    function setArbitrationPrice(uint256 price) external onlyOwner {
        arbitrationPrice = price;
        emit ArbitrationPriceUpdated(price);
    }

    function setArbiterPubKey(bytes32 pubKey) external onlyOwner {
        arbiterPubKey = pubKey;
        emit ArbiterPubKeyUpdated(pubKey);
    }

    function withdrawFees(address payable to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    function disputeCount() external view returns (uint256) {
        return disputes.length;
    }
}
