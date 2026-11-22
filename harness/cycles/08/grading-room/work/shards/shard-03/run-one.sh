#!/bin/sh
id="$1"
mkdir -p "work/$id"
cp work/run.js "work/$id/run.js"
cmd="apk add nodejs; date -u -s '2026-11-22 00:00:00'; cp -R /candidate /tmp/app; cd /tmp/app; ./start.sh 8080 >/out/server.log 2>&1 & p=\$!; for i in \$(seq 1 30); do curl -sf http://127.0.0.1:8080/api/docs >/out/docs && break; sleep 1; done; node /out/run.js $id; code=\$?; kill \$p; wait \$p 2>/dev/null; exit \$code"
printf '%s\n' "gondolin exec --image PINNED --dns open --mount-hostfs impl:/candidate:ro --mount-hostfs work/$id:/out -- sh -c $cmd" > "work/$id/command.log"
gondolin exec --image /Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure --dns open --mount-hostfs "$PWD/impl:/candidate:ro" --mount-hostfs "$PWD/work/$id:/out" -- sh -c "$cmd" > "work/$id/vm.log" 2>&1
printf 'exit=%s\n' "$?" >> "work/$id/command.log"
