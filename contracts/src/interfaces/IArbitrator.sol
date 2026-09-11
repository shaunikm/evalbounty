// SPDX-License-Identifier: MIT
// ERC-792 Arbitration Standard (Kleros). Vendored from https://github.com/kleros/erc-792
pragma solidity ^0.8.24;

import {IArbitrable} from "./IArbitrable.sol";

/// @title IArbitrator — ERC-792 arbitrator interface.
/// A contract that resolves disputes raised by arbitrable contracts and calls back `rule()`.
interface IArbitrator {
    enum DisputeStatus {
        Waiting,
        Appealable,
        Solved
    }

    event DisputeCreation(uint256 indexed _disputeID, IArbitrable indexed _arbitrable);
    event AppealPossible(uint256 indexed _disputeID, IArbitrable indexed _arbitrable);
    event AppealDecision(uint256 indexed _disputeID, IArbitrable indexed _arbitrable);

    function createDispute(uint256 _choices, bytes calldata _extraData) external payable returns (uint256 disputeID);
    function arbitrationCost(bytes calldata _extraData) external view returns (uint256 cost);
    function appeal(uint256 _disputeID, bytes calldata _extraData) external payable;
    function appealCost(uint256 _disputeID, bytes calldata _extraData) external view returns (uint256 cost);
    function appealPeriod(uint256 _disputeID) external view returns (uint256 start, uint256 end);
    function disputeStatus(uint256 _disputeID) external view returns (DisputeStatus status);
    function currentRuling(uint256 _disputeID) external view returns (uint256 ruling);
}
