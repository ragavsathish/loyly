#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node is required"
  exit 1
fi
NODE_VERSION="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "FATAL: Node.js 18+ required"
  exit 1
fi
exec node --test test/items.test.js