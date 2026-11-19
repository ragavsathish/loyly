#!/bin/sh
# Test-only process adapter fixture: a gate-green app, no model or VM.
set -eu
room="${1:?room}"
instruction="${2:?instruction}"
mkdir -p "$BUILDER_EVIDENCE_DIR/launch-1"
launch="$BUILDER_EVIDENCE_DIR/launch-1/launch.txt"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "request_id=${LOYLY_BUILDER_REQUEST_ID:-$LOYLY_BUILDER_SESSION_ID}"
  echo "room=$room"
  echo "builder_image=$3"
  echo "instruction_sha256=$(shasum -a 256 "$instruction" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "store=${LOYLY_BUILDER_STORE:-}"
  echo "parent_conversation_receipt=${LOYLY_PI_PARENT_RECEIPT:-}"
  echo "wrapper_pid=$$"
} > "$launch"
cp -R "$(dirname "$0")/../fixture/legacy-app" "$room/impl"
echo exit=0 >> "$launch"
