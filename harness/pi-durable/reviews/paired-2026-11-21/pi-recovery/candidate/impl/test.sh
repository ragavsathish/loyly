#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npm ci --include=dev --cache .npm-cache --no-audit --no-fund
node --check server.mjs
node --check app.js
node --test --test-concurrency=1 tests/*.test.mjs
