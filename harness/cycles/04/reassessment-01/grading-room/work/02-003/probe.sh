set -x
apk add nodejs=24.22.3-r0 icu-data-full=78.1-r0 || exit 10
node --version
date -u -s 2030-01-01T08:00:00Z || exit 11
cp -R /candidate /tmp/app
cd /tmp/app
./start.sh 3000 >/work/server.log 2>&1 &
p=$!
trap 'kill "$p" 2>/dev/null; wait "$p" 2>/dev/null' EXIT
sleep 3
node /work/probe.js
