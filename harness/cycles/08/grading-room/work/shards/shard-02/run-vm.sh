#!/bin/sh
id="$1"
mkdir -p "work/$id"
cp work/probe.js "work/$id/probe.js"
cmd="apk add --no-cache nodejs; cp -R /candidate /tmp/app; cd /tmp/app; ./start.sh 8123 >/out/server.log 2>&1 & p=\$!; trap 'kill \$p 2>/dev/null; wait \$p 2>/dev/null' EXIT; for i in \$(seq 1 20); do curl -sf http://127.0.0.1:8123/api/docs >/dev/null && break; sleep 1; done; node /out/probe.js $id"
printf '%s\n' "gondolin exec --image PINNED --dns open --mount-hostfs impl:/candidate:ro --mount-hostfs work/$id:/out -- sh -c $cmd" >"work/$id/command.log"
gondolin exec --image /Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure --dns open --mount-hostfs "$PWD/impl:/candidate:ro" --mount-hostfs "$PWD/work/$id:/out" -- sh -c "$cmd" >>"work/$id/command.log" 2>&1
status=$?
printf '\nVM exit: %s\n' "$status" >>"work/$id/command.log"
