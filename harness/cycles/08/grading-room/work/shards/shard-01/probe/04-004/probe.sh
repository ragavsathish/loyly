set -x
timeout 45 apk add nodejs
node --version || exit 42
cp -R /candidate /tmp/app
cd /tmp/app
./start.sh 8123 > /out/server.log 2>&1 & pid=$!
trap 'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8123/ > /out/root.html && break; sleep 1; done
curl -isS http://127.0.0.1:8123/ > /out/response.txt
