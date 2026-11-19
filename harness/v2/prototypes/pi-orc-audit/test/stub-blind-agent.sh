#!/bin/sh
# Test-only process adapter. It proves the room, receipt and handoff, not model judgment.
set -eu
room="${1:?blind-room}"
instruction="${2:?instruction}"
image="${3:?image}"
test "$(find "$room" -maxdepth 1 -type f | wc -l | tr -d ' ')" = 2
test -f "$room/refusal.txt"
test -f "$room/question.txt"
launch="$BUILDER_EVIDENCE_DIR/launch-1"
mkdir -p "$launch"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "room=$room"
  echo "builder_image=$image"
  echo "instruction_sha256=$(shasum -a 256 "$instruction" | cut -d' ' -f1)"
  echo "image_manifest_sha256=$(shasum -a 256 "$image/manifest.json" | cut -d' ' -f1)"
  echo "pi_settings_sha256=$(shasum -a 256 "$LOYLY_BUILDER_PI_SETTINGS" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "room_readonly_inputs=${LOYLY_ROOM_READONLY_INPUTS:-0}"
  echo "wrapper_pid=$$"
} > "$launch/launch.txt"
echo 'REQUEST: pukuhuone 9 | Thursday | 17:00 | 18:30' > "$launch/pi.stdout"
echo exit=0 >> "$launch/launch.txt"
