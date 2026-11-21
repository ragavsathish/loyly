#!/bin/sh
id="$1"
echo "gondolin exec --image PINNED --mount-hostfs impl:/candidate:ro --mount-hostfs work/$id:/result -- sh -c 'apk add nodejs; date -u -s 2026-11-21T12:00:00Z; copy candidate; start app; node /result/probe.js $id; stop and reap'" > "work/$id/command.txt"
gondolin exec --image /Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure --mount-hostfs "$PWD/impl:/candidate:ro" --mount-hostfs "$PWD/work/$id:/result" -- sh -c 'set -x; apk add nodejs; date -u -s 2026-11-21T12:00:00Z; cp -R /candidate /tmp/app; cd /tmp/app; ./start.sh 8080 >/tmp/server.log 2>&1 & p=$!; for i in $(seq 1 40); do curl -fsS http://127.0.0.1:8080/api/contract >/result/contract.json && break; sleep 1; done; node /result/probe.js "$1"; rc=$?; cat /tmp/server.log; kill $p; wait $p 2>/dev/null || true; exit $rc' sh "$id" > "work/$id/receipt-final.txt" 2>&1
printf 'exit=%s\n' "$?" >> "work/$id/receipt-final.txt"
