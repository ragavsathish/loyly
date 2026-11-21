#!/bin/sh
id="$1"
mkdir -p "work/$id"
cp work/probe.js "work/$id/probe.js"
printf '%s\n' 'gondolin exec --image PINNED --mount-hostfs impl:/candidate:ro --mount-hostfs work/ITEM:/result -- sh -c guest command; apk add nodejs; date -u -s baseline; copy candidate; start; probe; terminate' > "work/$id/command.txt"
gondolin exec --image /Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure --mount-hostfs "$PWD/impl:/candidate:ro" --mount-hostfs "$PWD/work/$id:/result" -- sh -c 'set -x; apk add nodejs; date -u -s "2026-11-21 12:00:00"; cp -R /candidate /tmp/app; cd /tmp/app; ./start.sh 8080 >/result/server-final.log 2>&1 & p=$!; for i in $(seq 1 30); do curl -fsS localhost:8080/api/houses >/result/houses-final.json && break; sleep 1; done; node /result/probe.js "$1"; code=$?; kill $p; wait $p 2>/dev/null; exit $code' sh "$id" >"work/$id/vm-final.log" 2>&1
printf '%s\n' $? >"work/$id/exit-final.txt"
