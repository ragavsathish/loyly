#!/usr/bin/env bash
set -euo pipefail
PORT="${1:?usage: start.sh PORT}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export NODE_ENV=production
exec node lib/run.js "$PORT"