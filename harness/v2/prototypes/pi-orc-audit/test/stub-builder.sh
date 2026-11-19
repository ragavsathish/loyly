#!/bin/sh
# Test-only host: exercises the durable build handoff without a model or VM.
set -eu
room="${1:?room}"
instruction="${2:?instruction}"
mkdir -p "$BUILDER_EVIDENCE_DIR/launch-1" "$room/impl"
launch="$BUILDER_EVIDENCE_DIR/launch-1/launch.txt"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "request_id=${LOYLY_BUILDER_REQUEST_ID:-$LOYLY_BUILDER_SESSION_ID}"
  echo "room=$room"
  echo "builder_image=$3"
  echo "instruction_sha256=$(shasum -a 256 "$instruction" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "wrapper_pid=$$"
} > "$launch"
printf '#!/bin/sh\nexit 0\n' > "$room/impl/test.sh"
printf '#!/bin/sh\necho sauna stub\n' > "$room/impl/start.sh"
chmod +x "$room/impl/test.sh" "$room/impl/start.sh"
echo exit=0 >> "$launch"
