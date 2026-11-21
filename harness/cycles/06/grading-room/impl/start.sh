#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node server.mjs "${1:?usage: start.sh PORT}"
