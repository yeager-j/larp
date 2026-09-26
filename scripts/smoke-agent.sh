#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/smoke-common.sh"

echo 'Agent smoke test: the configured reviewer Role, started and then continued.'
out=$(node dist/cli.js agent start --role reviewer --message 'Summarize README.md in two sentences. Do not modify files.')
echo "$out"
id=$(sed -n 's/^\[larp\] agent \([^ ]*\) .*/\1/p' <<<"$out")
if [[ -z "$id" ]]; then
  echo 'Agent start did not return an Agent ID.' >&2
  exit 1
fi
node dist/cli.js agent message "$id" --message 'Name one risk in the design, in one sentence.'
echo 'Agent smoke test exited.'
