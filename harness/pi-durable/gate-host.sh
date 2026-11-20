#!/usr/bin/env bash
# Receipt wrapper for the unchanged legacy gate. Runs in an independent copy.
set -uo pipefail
ROOM="${1:?gate room}"; OUT="${2:?receipt directory}"; CANDIDATE="${3:?candidate SHA-256}"
PROFILE="${4:-booking-core}"; INSTRUMENT="${5:-}"; COMMIT="${6:-}"; SLICE="${7:-}"
mkdir -p "$OUT"
tmp="$OUT/running.tmp.$$"
{ echo "pid=$$"; echo "room=$ROOM"; echo "candidate_sha256=$CANDIDATE"
  echo "gate_profile=$PROFILE"; echo "instrument_root=$INSTRUMENT"
  echo "instrument_commit=$COMMIT"; echo "slice=$SLICE"; } > "$tmp"
mv "$tmp" "$OUT/running.txt"
if [[ "$PROFILE" == spec-v2 ]]; then
  if [[ "$(git -C "$INSTRUMENT" rev-parse HEAD 2>/dev/null)" != "$COMMIT" ]] \
      || [[ -n "$(git -C "$INSTRUMENT" status --porcelain 2>/dev/null)" ]]; then
    echo "FATAL: spec-v2 gate instrument changed after launch" > "$OUT/gate.log.tmp"
    rc=1
  else
    bash "$INSTRUMENT/harness/v2/gate.sh" "$SLICE" "$ROOM" > "$OUT/gate.log.tmp" 2>&1
    rc=$?
  fi
else
  bash "$ROOM/harness/verify.sh" > "$OUT/gate.log.tmp" 2>&1
  rc=$?
fi
mv "$OUT/gate.log.tmp" "$OUT/gate.log"
sha="$(shasum -a 256 "$OUT/gate.log" | cut -d' ' -f1)"
tmp="$OUT/receipt.tmp.$$"
{ echo "exit=$rc"; echo "room=$ROOM"; echo "candidate_sha256=$CANDIDATE"
  echo "gate_profile=$PROFILE"; echo "instrument_root=$INSTRUMENT"
  echo "instrument_commit=$COMMIT"; echo "slice=$SLICE"; echo "log_sha256=$sha"; } > "$tmp"
mv "$tmp" "$OUT/receipt.txt"
exit "$rc"
