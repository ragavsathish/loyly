#!/bin/sh
# Test-only builder with two uncarried turns in one session, no model or VM.
set -eu
room="${1:?room}"
instruction="${2:?instruction}"
rid="${LOYLY_BUILDER_REQUEST_ID:?request id}"
mode="${LOYLY_TEST_CONTINUATION_MODE:-carry}"
n=$(find "$BUILDER_EVIDENCE_DIR" -maxdepth 1 -type d -name 'launch-*' | wc -l | tr -d ' ')
n=$((n + 1))
mkdir -p "$BUILDER_EVIDENCE_DIR/launch-$n"
launch="$BUILDER_EVIDENCE_DIR/launch-$n/launch.txt"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "request_id=$rid"
  echo "room=$room"
  echo "builder_image=$3"
  echo "instruction_sha256=$(shasum -a 256 "$instruction" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "wrapper_pid=$$"
} > "$launch"
if [ "$rid" != "$LOYLY_BUILDER_SESSION_ID" ] && [ -n "${LOYLY_TEST_CONTINUATION_DELAY_SECONDS:-}" ]; then
  sleep "$LOYLY_TEST_CONTINUATION_DELAY_SECONDS"
fi
case "$rid" in
  *-c1)
    if [ "$mode" != unchanged ]; then
      printf 'carried first\n' > "$room/impl/continuation-1.txt"
      if [ "$mode" = cap ]; then
        printf '%s\n' '- @item-01-001: still working' '- @item-01-002: still working' > "$room/impl/UNCARRIED.md"
      else
        printf '%s\n' '- @item-01-002: still working' > "$room/impl/UNCARRIED.md"
      fi
    fi
    ;;
  *-c2)
    printf 'carried second\n' > "$room/impl/continuation-2.txt"
    if [ "$mode" = cap ]; then
      printf '%s\n' '- @item-01-001: still working' '- @item-01-002: still working' > "$room/impl/UNCARRIED.md"
    else
      : > "$room/impl/UNCARRIED.md"
    fi
    ;;
  *-c3)
    if [ "$mode" = cap ]; then
      printf 'third turn\n' > "$room/impl/continuation-3.txt"
    else
      echo 'third continuation should not run' >&2
      exit 1
    fi
    ;;
  *)
    cp -R "$(dirname "$0")/../fixture/legacy-app" "$room/impl"
    printf '%s\n' '- @item-01-001: still working' '- @item-01-002: still working' > "$room/impl/UNCARRIED.md"
    ;;
esac
echo exit=0 >> "$launch"
