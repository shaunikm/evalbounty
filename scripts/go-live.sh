#!/usr/bin/env bash
# One command from "deployer funded" to "submission-ready":
#   ./scripts/go-live.sh            deploy (if not yet), fund agents, verify source, fill README
#   ./scripts/go-live.sh --demo     ...and run all four stories on Sepolia (≈ 8-12 min)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
export CHAIN=sepolia
set -a; source agents/.env; set +a

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
echo "deployer $DEPLOYER  balance $(cast balance "$DEPLOYER" --rpc-url "$RPC_URL" --ether) ETH  gas $(cast gas-price --rpc-url "$RPC_URL") wei"

if [[ -z "${EVALBOUNTY_ADDRESS:-}" ]]; then
  pnpm --filter agents deploy-contracts
  set -a; source agents/.env; set +a
else
  echo "already deployed at $EVALBOUNTY_ADDRESS (delete EVALBOUNTY_ADDRESS in agents/.env to redeploy)"
  pnpm --filter agents fund
fi

./scripts/verify-sepolia.sh || echo "verification had errors; rerun ./scripts/verify-sepolia.sh later"

if [[ "${1:-}" == "--demo" ]]; then
  pnpm --filter agents demo
fi

sed -i '' "s|<EVALBOUNTY_ADDRESS>|$EVALBOUNTY_ADDRESS|g; s|<ARBITRATOR_ADDRESS>|$ARBITRATOR_ADDRESS|g" README.md
echo
echo "EvalBounty:  https://sepolia.etherscan.io/address/$EVALBOUNTY_ADDRESS"
echo "Arbitrator:  https://sepolia.etherscan.io/address/$ARBITRATOR_ADDRESS"
echo "Dashboard config written to dashboard/config.js; README addresses filled in."
if command -v vercel >/dev/null 2>&1 && vercel whoami >/dev/null 2>&1; then
  echo "Deploying dashboard to Vercel…"
  vercel --prod --yes | tee /tmp/vercel-deploy.log
  URL=$(grep -Eo 'https://[a-z0-9.-]+\.vercel\.app' /tmp/vercel-deploy.log | tail -1 || true)
  [[ -n "$URL" ]] && sed -i '' "s|<DASHBOARD_URL>|$URL|g" README.md && echo "README dashboard URL set to $URL"
else
  echo "Vercel: run 'npx vercel login' once, then 'npx vercel --prod' from the repo root (vercel.json serves dashboard/)."
fi
echo "Next: commit + push, make the repo public, record the video, paste its URL into README.md, submit the form."
