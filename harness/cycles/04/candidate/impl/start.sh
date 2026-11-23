#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node server.mjs "${1:?usage: start.sh PORT}"
