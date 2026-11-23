#!/bin/sh
set -eu
apk add --no-cache nodejs >/out/apk.log 2>&1
cp -R /candidate /tmp/runtime
cd /tmp/runtime
./start.sh 18123 >/out/server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
ready=0
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -sf http://127.0.0.1:18123/ >/out/root.html; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || exit 2
curl -sS -i http://127.0.0.1:18123/api/houses >/out/houses.http
curl -sS -i http://127.0.0.1:18123/api/state >/out/state.http
