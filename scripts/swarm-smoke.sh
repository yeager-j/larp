#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/smoke-common.sh"
command -v codex >/dev/null
node scripts/swarm-smoke.mjs
