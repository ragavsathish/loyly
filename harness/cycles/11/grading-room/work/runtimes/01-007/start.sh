#!/usr/bin/env bash
set -euo pipefail
PORT="${1:?usage: start.sh PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LOYLY_PORT="$PORT"
exec node "$ROOT/src/start-main.js"