// SPDX-License-Identifier: MIT
// ERC-1497 Evidence Standard (Kleros). Vendored from https://github.com/kleros/erc-792
pragma solidity ^0.8.24;

import {IArbitrator} from "./IArbitrator.sol";

/// @title IEvidence — ERC-1497 evidence events so generic arbitration UIs can follow a dispute.
interface IEvidence {
    event MetaEvidence(uint256 indexed _metaEvidenceID, string _evidence);
    event Evidence(IArbitrator indexed _arbitrator, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence);
    event Dispute(IArbitrator indexed _arbitrator, uint256 indexed _disputeID, uint256 _metaEvidenceID, uint256 _evidenceGroupID);
}
