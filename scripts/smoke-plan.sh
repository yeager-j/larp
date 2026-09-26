#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  echo 'Usage: scripts/smoke-plan.sh [claude|codex]'
  exit 1
fi

case "${1:-claude}" in
  claude) reviewer='claude:haiku' ;;
  codex) reviewer="codex:${LARP_CODEX_MODEL:-gpt-5.6-sol}" ;;
  *) echo 'Usage: scripts/smoke-plan.sh [claude|codex]'; exit 1 ;;
esac

source "$(dirname "$0")/smoke-common.sh"
task='Inspect this repository and propose a short summary of its purpose. Implementation means reporting the summary only; do not modify files or use git.'
echo "Planning smoke test: Haiku as Planner; ${reviewer} as Reviewer."
echo 'Approval opens a Codex desktop composer; press Send there to implement.'
node dist/cli.js plan "$task" --planner claude:haiku --reviewer "$reviewer"
