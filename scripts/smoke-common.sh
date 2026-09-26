# Shared opt-in and build setup, sourced by each independent live smoke test.
set -euo pipefail

if [[ "${LARP_LIVE_SMOKE:-}" != "1" ]]; then
  echo 'Live smoke tests require explicit opt-in: LARP_LIVE_SMOKE=1 npm run <smoke-command>.'
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm run build
