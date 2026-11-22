set -x
timeout 45 apk add nodejs || exit 42
if [ "$1" = 02-008 ] || [ "$1" = 04-004 ]; then date -u -s '2026-11-22 00:00:00' || exit 43; fi
cp -R /candidate /tmp/app
cd /tmp/app
./start.sh 8123 > /out/server.log 2>&1 & pid=$!
trap 'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8123/ > /out/root.html && break; sleep 1; done
node /out/scenario.js "$1" > /out/observations.txt 2>&1
