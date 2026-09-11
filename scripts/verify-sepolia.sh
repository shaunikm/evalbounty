#!/usr/bin/env bash
# Verify both contracts' source on Sepolia explorers.
#   ./scripts/verify-sepolia.sh                 # Sourcify + Blockscout (no API key needed)
#   ETHERSCAN_API_KEY=... ./scripts/verify-sepolia.sh   # also Etherscan
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source agents/.env; set +a
: "${EVALBOUNTY_ADDRESS:?run deploy first}"; : "${ARBITRATOR_ADDRESS:?run deploy first}"

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
ARBITER=$(cast wallet address --private-key "$ARBITER_KEY")
ARBITER_PUB=$(python3 -c "import json;print(json.load(open('agents/state/arbiter-x25519.json'))['publicKey'])")
PRICE=200000000000000   # 0.0002 ETH, must match agents/src/deploy.ts ARBITRATION_PRICE
W_APPROVE=${APPROVE_WINDOW:-1800}; W_DELIVER=${DELIVER_WINDOW:-1800}; W_VERIFY=${VERIFY_WINDOW:-3600}; W_RULE=${RULE_WINDOW:-3600}
META="https://github.com/shaunikm/technical-interview/blob/main/dashboard/meta-evidence.json"

ARB_ARGS=$(cast abi-encode "constructor(address,uint256,bytes32)" "$ARBITER" "$PRICE" "$ARBITER_PUB")
EB_ARGS=$(cast abi-encode "constructor(address,address,(uint64,uint64,uint64,uint64),string)" "$ARBITRATOR_ADDRESS" "$DEPLOYER" "($W_APPROVE,$W_DELIVER,$W_VERIFY,$W_RULE)" "$META")

verify() { # name address ctor-args
  local name=$1 addr=$2 args=$3
  echo "== $name @ $addr"
  forge verify-contract --root contracts --chain sepolia --watch --verifier sourcify --constructor-args "$args" "$addr" "src/$name.sol:$name" || echo "(sourcify failed)"
  forge verify-contract --root contracts --chain sepolia --watch --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/ --constructor-args "$args" "$addr" "src/$name.sol:$name" || echo "(blockscout failed)"
  if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
    forge verify-contract --root contracts --chain sepolia --watch --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" --constructor-args "$args" "$addr" "src/$name.sol:$name" || echo "(etherscan failed)"
  fi
}
verify CentralizedArbitrator "$ARBITRATOR_ADDRESS" "$ARB_ARGS"
verify EvalBounty "$EVALBOUNTY_ADDRESS" "$EB_ARGS"
echo "Etherscan: https://sepolia.etherscan.io/address/$EVALBOUNTY_ADDRESS#code"
echo "Blockscout: https://eth-sepolia.blockscout.com/address/$EVALBOUNTY_ADDRESS?tab=contract"
