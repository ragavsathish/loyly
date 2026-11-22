#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node --check server.mjs
node --check public/app.js
node --test --test-concurrency=1 test/*.test.mjs
