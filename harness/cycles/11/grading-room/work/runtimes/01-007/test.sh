#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if ! command -v node >/dev/null 2>&1; then
  echo "node is required"
  exit 1
fi
if ! node --test --help >/dev/null 2>&1; then
  echo "node built-in test runner is required"
  exit 1
fi
exec node --test test/*.test.js