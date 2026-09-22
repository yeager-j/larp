#!/usr/bin/env bash
set -euo pipefail
if [[ "${LARP_LIVE_SMOKE:-}" != "1" ]]; then
  echo 'Opt in with LARP_LIVE_SMOKE=1 scripts/smoke.sh. Requires larp config, Claude/Codex authentication, and a terminal.'
  exit 1
fi
cd "$(dirname "$0")/.."
npm run build
task='Inspect this repository and propose a short summary of its purpose. Implementation means reporting the summary only; do not modify files or use git.'
echo 'This script runs two independent smoke tests, each with its own approval Gate.'
echo 'Smoke test 1/2: Haiku as Planner, Reviewer, and Implementer.'
node dist/cli.js plan "$task" --planner claude:haiku --reviewer claude:haiku --implementer claude:haiku
echo 'Smoke test 1/2 exited. Starting a NEW Run for smoke test 2/2.'
echo "Smoke test 2/2: Haiku as Planner and Implementer; ${LARP_CODEX_MODEL:-gpt-5.6-sol} as Reviewer."
node dist/cli.js plan "$task" --planner claude:haiku --reviewer "codex:${LARP_CODEX_MODEL:-gpt-5.6-sol}" --implementer claude:haiku
echo 'Both smoke-test commands exited.'
