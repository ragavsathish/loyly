#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node server.js "${1:?usage: start.sh PORT}"
