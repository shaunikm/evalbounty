#!/usr/bin/env bash
# Enter secrets into agents/.env without them ever appearing in a chat or shell history.
#
#   ./scripts/set-keys.sh                      prompts for every key (hidden input, Enter = keep current)
#   ./scripts/set-keys.sh ETHERSCAN_API_KEY    prompts for just that key
#   ./scripts/set-keys.sh --show               lists which keys are set (values masked)
#
# Values are read with `read -s` (no echo), written straight to agents/.env (mode 600), never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="agents/.env"
[[ -f "$ENV_FILE" ]] || { cp agents/.env.example "$ENV_FILE"; echo "created $ENV_FILE from .env.example"; }
chmod 600 "$ENV_FILE"

# name|hint|validator-regex (empty = anything)
KEYS=(
  "ETHERSCAN_API_KEY|free key from https://etherscan.io/myapikey (verified-source tab on Etherscan); Sourcify/Blockscout work without it|^[A-Za-z0-9]{20,64}$"
  "ANTHROPIC_API_KEY|only if you want MODEL_PROVIDER=anthropic (real Claude models instead of the mock)|^sk-ant-"
  "OPENAI_API_KEY|only if you want MODEL_PROVIDER=openai|^sk-"
  "RPC_URL|optional private Sepolia RPC (Alchemy/Infura https URL); default public RPC is fine|^https?://"
  "MODEL_PROVIDER|mock (default, no keys needed) | anthropic | openai|^(mock|anthropic|openai)$"
)

set_var() { # key value
  local key=$1 val=$2 tmp
  tmp=$(mktemp)
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"; printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
mask() { local v=$1; [[ -z "$v" ]] && { echo "(unset)"; return; }; echo "${v:0:4}…${v: -3} (${#v} chars)"; }
current() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

if [[ "${1:-}" == "--show" ]]; then
  for entry in "${KEYS[@]}"; do k=${entry%%|*}; printf '%-20s %s\n' "$k" "$(mask "$(current "$k")")"; done
  printf '%-20s %s\n' "EVALBOUNTY_ADDRESS" "$(current EVALBOUNTY_ADDRESS)"
  exit 0
fi

only=${1:-}
for entry in "${KEYS[@]}"; do
  IFS='|' read -r key hint pattern <<<"$entry"
  [[ -n "$only" && "$only" != "$key" ]] && continue
  cur=$(current "$key")
  echo
  echo "$key  —  $hint"
  echo "  current: $(mask "$cur")"
  printf '  new value (hidden; Enter to keep, "-" to clear): '
  read -rs val; echo
  [[ -z "$val" ]] && { echo "  kept"; continue; }
  [[ "$val" == "-" ]] && { set_var "$key" ""; echo "  cleared"; continue; }
  if [[ -n "$pattern" && ! "$val" =~ $pattern ]]; then
    echo "  that does not look like a valid $key (expected to match $pattern); not saved"; continue
  fi
  set_var "$key" "$val"; echo "  saved ($(mask "$val"))"
done
echo
echo "agents/.env updated (gitignored, mode 600). Check with: ./scripts/set-keys.sh --show"
