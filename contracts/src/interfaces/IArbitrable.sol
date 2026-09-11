// SPDX-License-Identifier: MIT
// ERC-792 Arbitration Standard (Kleros). Vendored from https://github.com/kleros/erc-792
pragma solidity ^0.8.24;

import {IArbitrator} from "./IArbitrator.sol";

/// @title IArbitrable — ERC-792 arbitrable interface.
/// A contract that can have disputes ruled on by an IArbitrator. Ruling 0 means "refused to arbitrate".
interface IArbitrable {
    event Ruling(IArbitrator indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling);

    function rule(uint256 _disputeID, uint256 _ruling) external;
}
