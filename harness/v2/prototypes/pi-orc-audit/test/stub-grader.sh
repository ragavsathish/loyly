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
  echo "room_readonly_inputs=${LOYLY_ROOM_READONLY_INPUTS:-0}"
  echo "wrapper_pid=$$"
} > "$launch"
node -e '
const fs = require("fs");
const crypto = require("crypto");
const path = process.argv[1];
const items = JSON.parse(fs.readFileSync(`${path}/checklist.json`, "utf8")).items;
const out = `${path}/work/allure-results`;
fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(`${path}/work/surprises.json`, "[]");
fs.writeFileSync(`${path}/work/blind-review-011.txt`, "Try Thursday in room 9.\n");
for (const item of items) {
  const pending = item.id === "01-011", uuid = crypto.randomUUID();
  const source = `${crypto.randomUUID()}-attachment.txt`;
  fs.writeFileSync(`${out}/${source}`, pending ? "Try Thursday in room 9.\n" : "stub fixture, no behavioral observation\n");
  const fullName = `loyly.booking-core.${item.id}`;
  const status = pending ? "skipped" : "passed";
  const result = {uuid, historyId:fullName, testCaseId:fullName, fullName,
    name:item.name, status, stage:pending ? "pending" : "finished",
    statusDetails:{message:pending ? "not reached: blind human review required" : "stub fixture, no behavioral observation"},
    start:Date.now(), stop:Date.now(),
    labels:[{name:"lifecycle",value:"pre-production"},{name:"technique",value:pending ? "usability" : "acceptance"},
      {name:"tool",value:"test stub"},{name:"feature",value:"Booking core"},
      {name:"story",value:item.rule},{name:"tag",value:`@item-${item.id}`}],
    steps:[{name:"When the fixture is inspected",status,stage:pending ? "pending" : "finished"}],
    attachments:[{name:"fixture observation",source,type:"text/plain"}]};
  fs.writeFileSync(`${out}/${uuid}-result.json`, JSON.stringify(result));
}
' "$room"
echo exit=0 >> "$launch"
