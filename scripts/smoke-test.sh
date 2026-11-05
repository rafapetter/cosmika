#!/usr/bin/env bash
# Post-deploy smoke test. Hits the live api + realtime + web endpoints and
# fails if any return non-2xx. Used by deploy.sh and as a CI verify step.
#
# Override targets via env:
#   API_URL=https://api.example.com
#   REALTIME_URL=https://realtime.example.com
#   WEB_URL=https://app.example.com

set -euo pipefail

API="${API_URL:-http://localhost:3110}"
RT="${REALTIME_URL:-http://localhost:3120}"
WEB="${WEB_URL:-http://localhost:3100}"

fail=0
check() {
  local name="$1"; local url="$2"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$url" || echo "000")
  if [ "$code" = "200" ]; then
    echo "  ok  $name ($code)"
  else
    echo "  FAIL $name ($code) at $url" >&2
    fail=1
  fi
}

echo "[smoke] api $API"
check "api health" "$API/health"
check "api ready" "$API/ready"

echo "[smoke] realtime $RT"
check "realtime health" "$RT/health"
check "realtime ready" "$RT/ready"

echo "[smoke] web $WEB"
check "web root" "$WEB/"

if [ $fail -ne 0 ]; then
  echo "[smoke] FAILED" >&2
  exit 1
fi
echo "[smoke] all checks passed"
