#!/bin/sh
# Test-only process: first builder turn fails after writing a partial candidate;
# the next attempt must see that candidate and the prior session receipt.
set -eu
room="${1:?room}"
instruction="${2:?instruction}"
attempt="${LOYLY_BUILDER_SESSION_ID##*-}"
mkdir -p "$BUILDER_EVIDENCE_DIR/launch-1" "$room/impl"
launch="$BUILDER_EVIDENCE_DIR/launch-1/launch.txt"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "request_id=$LOYLY_BUILDER_REQUEST_ID"
  echo "room=$room"
  echo "builder_image=$3"
  echo "instruction_sha256=$(shasum -a 256 "$instruction" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "store=$LOYLY_BUILDER_STORE"
  echo "parent_conversation_receipt=${LOYLY_PI_PARENT_RECEIPT:-}"
  echo "wrapper_pid=$$"
} > "$launch"
printf '{"store":"%s","conversationId":%s,"parentConversationId":null,"forkEntryId":null,"lastEntryId":%s}\n' \
  "$LOYLY_BUILDER_STORE" "$attempt" "$attempt" > "$BUILDER_EVIDENCE_DIR/session.json"
if [ "$attempt" = 1 ]; then
  printf 'partial candidate\n' > "$room/impl/partial.txt"
  if [ "${LOYLY_TEST_FORK_MODE:-repair}" = gate-red ]; then
    cp -R "$(dirname "$0")/../fixture/legacy-app/." "$room/impl/"
    printf '#!/bin/sh\nexit 1\n' > "$room/impl/test.sh"
    chmod +x "$room/impl/test.sh"
    echo exit=0 >> "$launch"
    exit 0
  fi
  if [ "${LOYLY_TEST_FORK_MODE:-repair}" = incomplete ]; then
    echo exit=0 >> "$launch"
    exit 0
  fi
  echo exit=1 >> "$launch"
  exit 1
fi
test -f "$room/impl/partial.txt"
test -f "$LOYLY_PI_PARENT_RECEIPT"
test "$(cat "$LOYLY_PI_PARENT_RECEIPT" | jq -r .conversationId)" = "$((attempt - 1))"
if [ "${LOYLY_TEST_FORK_MODE:-repair}" = gate-red ]; then
  grep -q 'Previous gate failure' "$instruction"
else
  grep -q 'Previous builder failure' "$instruction"
fi
if [ "${LOYLY_TEST_FORK_MODE:-repair}" = alwaysfail ]; then
  echo exit=1 >> "$launch"
  exit 1
fi
cp -R "$(dirname "$0")/../fixture/legacy-app/." "$room/impl/"
echo exit=0 >> "$launch"
