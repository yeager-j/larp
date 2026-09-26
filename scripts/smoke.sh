#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo 'This shortcut runs the two planning smoke tests and the standalone Agent test. Run npm run smoke:swarm separately for the swarm test.'
bash scripts/smoke-plan.sh claude
read -r -p 'Inspect the first Codex composer, then press Enter to start the second planning test. ' reply
bash scripts/smoke-plan.sh codex
bash scripts/smoke-agent.sh
