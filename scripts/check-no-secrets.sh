#!/usr/bin/env bash
# Refuse to publish if any secret from agents/.env appears in a tracked file or in dashboard/.
# Run before `git push` and before `vercel --prod`. Exits 1 on any hit.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1. No .env or state files tracked.
if git ls-files | grep -E '(^|/)\.env$|^agents/state/|config\.local\.js$'; then
  echo "✗ secret-bearing file is tracked by git"; fail=1
fi

# 2. No exact secret values from agents/.env in tracked files or the dashboard folder.
if [[ -f agents/.env ]]; then
  for var in DEPLOYER_KEY BUYER_KEY SELLER_KEY ARBITER_KEY JUNK_SELLER_KEY ETHERSCAN_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY; do
    val=$(grep -E "^${var}=" agents/.env | head -1 | cut -d= -f2- || true)
    [[ -z "$val" || ${#val} -lt 12 ]] && continue
    if git grep -qF -- "$val" -- . ':!agents/.env' 2>/dev/null || grep -rqF -- "$val" dashboard/ 2>/dev/null; then
      echo "✗ value of $var appears in a tracked file or dashboard/"; fail=1
    fi
  done
fi

# 3. Nothing shaped like an API key anywhere that ships.
if git grep -nE 'sk-(proj|ant)-[A-Za-z0-9_-]{16,}' -- . ':!scripts/check-no-secrets.sh' 2>/dev/null; then
  echo "✗ API-key-shaped string in tracked files"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "✓ no secrets in tracked files or dashboard/"; fi
exit $fail
