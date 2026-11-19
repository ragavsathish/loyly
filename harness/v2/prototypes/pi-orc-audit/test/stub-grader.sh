#!/bin/sh
# Test-only grader: proves the process handoff and score path, not app behavior.
set -eu
room="${1:?room}"
instruction="${2:?instruction}"
mkdir -p "$BUILDER_EVIDENCE_DIR/launch-1" "$room/work"
launch="$BUILDER_EVIDENCE_DIR/launch-1/launch.txt"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "room=$room"
  echo "builder_image=$3"
  echo "instruction_sha256=$(shasum -a 256 "$instruction" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "wrapper_pid=$$"
} > "$launch"
node -e '
const fs = require("fs");
const path = process.argv[1];
const ids = JSON.parse(fs.readFileSync(`${path}/checklist.json`, "utf8")).items.map(x => x.id);
const verdicts = ids.map(id => ({id, verdict: id === "01-011" ? "fail" : "pass",
  evidence: id === "01-011" ? "not reached: blind human review required" : "stub fixture, no behavioral observation"}));
fs.writeFileSync(`${path}/work/verdicts.json`, JSON.stringify(verdicts));
fs.writeFileSync(`${path}/work/surprises.json`, "[]");
fs.writeFileSync(`${path}/work/blind-review-011.txt`, "Try Thursday in room 9.\n");
' "$room"
echo exit=0 >> "$launch"
