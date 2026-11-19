#!/usr/bin/env bash
# Receipt wrapper for the unchanged legacy gate. Runs in an independent copy.
set -uo pipefail
ROOM="${1:?gate room}"; OUT="${2:?receipt directory}"; CANDIDATE="${3:?candidate SHA-256}"
mkdir -p "$OUT"
tmp="$OUT/running.tmp.$$"
{ echo "pid=$$"; echo "room=$ROOM"; echo "candidate_sha256=$CANDIDATE"; } > "$tmp"
mv "$tmp" "$OUT/running.txt"
bash "$ROOM/harness/verify.sh" > "$OUT/gate.log.tmp" 2>&1
rc=$?
mv "$OUT/gate.log.tmp" "$OUT/gate.log"
sha="$(shasum -a 256 "$OUT/gate.log" | cut -d' ' -f1)"
tmp="$OUT/receipt.tmp.$$"
{ echo "exit=$rc"; echo "room=$ROOM"; echo "candidate_sha256=$CANDIDATE"; echo "log_sha256=$sha"; } > "$tmp"
mv "$tmp" "$OUT/receipt.txt"
exit "$rc"
