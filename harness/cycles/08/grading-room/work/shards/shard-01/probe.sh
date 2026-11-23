set -x
timeout 45 apk add nodejs
node --version || exit 42
cp -R /candidate /tmp/app
cd /tmp/app
./start.sh 8123 > /out/server.log 2>&1 & pid=$!
trap 'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8123/ > /out/root.html && break; sleep 1; done
for path in api/state api/houses 'api/schedule?house=soukanvuori' 'api/views?house=soukanvuori&date=2026-11-24' app.js; do echo "GET $path"; curl -sS "http://127.0.0.1:8123/$path"; echo; done > /out/discovery.txt
curl -sS -X POST -H 'Content-Type: application/json' -d '{"house":"soukanvuori","household":"12","role":"shareholder","resource":"8","day":"Tuesday","start":"17:00"}' http://127.0.0.1:8123/api/bookings > /out/booking.txt
curl -sS http://127.0.0.1:8123/api/state > /out/after.txt
