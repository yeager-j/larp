#!/usr/bin/env bash
set -euo pipefail
if [[ "${LARP_LIVE_SMOKE:-}" != "1" ]]; then
  echo 'Opt in with LARP_LIVE_SMOKE=1 scripts/smoke.sh. Requires larp config, Claude/Codex authentication, and a terminal.'
  exit 1
fi
cd "$(dirname "$0")/.."
npm run build
task='Inspect this repository and propose a short summary of its purpose. Implementation means reporting the summary only; do not modify files or use git.'
echo 'This script runs two independent planning tests. Each approval opens a Codex desktop composer; press Send there to implement.'
echo 'Smoke test 1/2: Haiku as Planner and Reviewer.'
node dist/cli.js plan "$task" --planner claude:haiku --reviewer claude:haiku
read -r -p 'Inspect the first Codex composer, then press Enter to start the second planning test. ' reply
echo 'Smoke test 1/2 exited. Starting a NEW Run for smoke test 2/2.'
echo "Smoke test 2/2: Haiku as Planner; ${LARP_CODEX_MODEL:-gpt-5.6-sol} as Reviewer."
node dist/cli.js plan "$task" --planner claude:haiku --reviewer "codex:${LARP_CODEX_MODEL:-gpt-5.6-sol}"
echo 'Both smoke-test commands exited.'
echo 'Agent smoke test: the configured reviewer Role, started and then continued.'
out=$(node dist/cli.js agent start --role reviewer --message 'Summarize README.md in two sentences. Do not modify files.')
echo "$out"
id=$(sed -n 's/^\[larp\] agent \([^ ]*\) .*/\1/p' <<<"$out")
node dist/cli.js agent message "$id" --message 'Name one risk in the design, in one sentence.'
echo 'Agent smoke test exited.'
