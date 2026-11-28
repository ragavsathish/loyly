#!/usr/bin/env bash
# LOYLY_BUILDER_CMD: <builder-room> <instruction-file> [<builder-image>]
# (../README.md, "The builder command"; ../../spec/cycle-runner/seam.md, "Handed in").
# The durable builder host (bin/loyly-clj builder-host -> harness/pi-durable/pi-builder-extension.ts)
# on the host, with pi's existing openai-codex login and the session's SQLite store; every tool call
# runs in a Gondolin VM that mounts only the builder room. The VM's guest is <builder-image>, the path
# LOYLY_BUILDER_IMAGES/BUILDER_IMAGE that the runner hands in when the configuration names one
# (spec round 9, D1, D4); without it, the TypeScript builder image, as in the shadow runs.
# The active cycle driver owns attempts and retries; the host owns the Pi session: the same
# LOYLY_BUILDER_SESSION_ID reopens the same store and request id, so a rerun resumes, never restarts.
# The wrapper only records the launch and the host's output under BUILDER_EVIDENCE_DIR; it changes
# nothing the builder sees.
#   BUILDER_EVIDENCE_DIR      where each launch's record (and session stores) go
#   LOYLY_BUILDER_SESSION_ID  optional: the durable session's key, [A-Za-z0-9._-]; store
#                             $BUILDER_EVIDENCE_DIR/sessions/<id>/session.sqlite, request id <id>.
#                             Without it: launch-N/session.sqlite, request id launch-N (a fresh session).
#   LOYLY_BUILDER_REQUEST_ID  optional with a session ID: a distinct input request on the same
#                             Pi store, used for bounded same-session continuation turns.
#   LOYLY_BUILDER_STORE       optional shared Pi SQLite store for forked repair attempts.
#   LOYLY_PI_PARENT_RECEIPT  optional completed prior attempt's session.json, used by builder-host
#                             to fork its transcript at the last committed entry.
#   LOYLY_BUILDER_PI_SETTINGS a pi settings.json whose defaultTools selects the builder's tools
#                             (default ../config/pi.builder.settings.json)
#   PI_HARNESS_STATE_ROOT     the state root (default .pi/harness/.state beside this script)
#   LOYLY_PI_MODEL            optional: provider/modelId (default openai-codex/gpt-6.1-sol)
# launch.txt also records model=, wrapper_pid= and host_pid= (for stop.sh), and steer_dir=, the
# host's steer inbox (LOYLY_STEER_DIR; written by steer.sh).
# launch.txt records the pi settings file, the image's Gondolin manifest.json and the VM policy
# (harness/loyly-clj/src/loyly/builder_host.cljc), each with its sha256.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOM="${1:?builder-room}"; INSTR="${2:?instruction-file}"; IMAGE="${3:-}"
EV="${BUILDER_EVIDENCE_DIR:?BUILDER_EVIDENCE_DIR: evidence directory}"
STATE="${PI_HARNESS_STATE_ROOT:-$HERE/../.state}"
REPO="$(cd "$HERE/../../.." && pwd)"
PI_EXT="$REPO/harness/pi-durable"
VM_POLICY="$REPO/harness/loyly-clj/src/loyly/builder_host.cljc"
PI_SETTINGS="${LOYLY_BUILDER_PI_SETTINGS:-$HERE/../config/pi.builder.settings.json}"
[[ -f "$PI_SETTINGS" ]] || { echo "pi settings not found: $PI_SETTINGS" >&2; exit 2; }
PI_SETTINGS="$(cd "$(dirname "$PI_SETTINGS")" && pwd)/$(basename "$PI_SETTINGS")"
SID="${LOYLY_BUILDER_SESSION_ID:-}"
[[ -z "$SID" || "$SID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad LOYLY_BUILDER_SESSION_ID: $SID" >&2; exit 2; }
if [[ -n "$IMAGE" ]]; then
  export GONDOLIN_GUEST_DIR="$IMAGE"
else
  export GONDOLIN_GUEST_DIR="$STATE/assets/builder"
fi
[[ -d "$GONDOLIN_GUEST_DIR" ]] || { echo "builder image not found: $GONDOLIN_GUEST_DIR" >&2; exit 2; }
[[ -d "$PI_EXT/node_modules" ]] || { echo "pi extension not installed: npm ci in $PI_EXT" >&2; exit 2; }
ROOM="$(cd "$ROOM" && pwd)" || exit 2
INSTR="$(cd "$(dirname "$INSTR")" && pwd)/$(basename "$INSTR")"
mkdir -p "$EV"
n=$(ls -d "$EV"/launch-* 2>/dev/null | wc -l | tr -d ' '); n=$((n+1)); L="$EV/launch-$n"; mkdir -p "$L"
if [[ -n "$SID" ]]; then
  STORE="${LOYLY_BUILDER_STORE:-$EV/sessions/$SID/session.sqlite}"; RID="${LOYLY_BUILDER_REQUEST_ID:-$SID}"
  [[ "$STORE" = /* ]] || { echo "LOYLY_BUILDER_STORE must be absolute" >&2; exit 2; }
  [[ "$RID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad LOYLY_BUILDER_REQUEST_ID: $RID" >&2; exit 2; }
else
  [[ -z "${LOYLY_BUILDER_REQUEST_ID:-}" ]] || { echo "LOYLY_BUILDER_REQUEST_ID needs LOYLY_BUILDER_SESSION_ID" >&2; exit 2; }
  STORE="$L/session.sqlite"; RID="launch-$n"
fi
mkdir -p "$(dirname "$STORE")"
export LOYLY_PI_CONVERSATION_RECEIPT="$EV/session.json"
{ echo "room=$ROOM"; echo "instruction=$INSTR"
  echo "instruction_sha256=$(shasum -a 256 "$INSTR" | cut -d' ' -f1)"
  echo "builder_image=$GONDOLIN_GUEST_DIR"
  sha() { [[ -f "$1" ]] && shasum -a 256 "$1" | cut -d' ' -f1 || echo missing; }
  echo "image_manifest=$GONDOLIN_GUEST_DIR/manifest.json"; echo "image_manifest_sha256=$(sha "$GONDOLIN_GUEST_DIR/manifest.json")"
  echo "pi_settings=$PI_SETTINGS"; echo "pi_settings_sha256=$(sha "$PI_SETTINGS")"
  echo "vm_policy=$VM_POLICY"; echo "vm_policy_sha256=$(sha "$VM_POLICY")"
  echo "room_readonly_inputs=${LOYLY_ROOM_READONLY_INPUTS:-0}"
  echo "bash_timeout_floor=${LOYLY_BASH_TIMEOUT_FLOOR_SECONDS:-1800}"
  echo "bash_timeout_ceiling=${LOYLY_BASH_TIMEOUT_CEILING_SECONDS:-none}"
  echo "session_id=$SID"; echo "store=$STORE"; echo "request_id=$RID"
  echo "parent_conversation_receipt=${LOYLY_PI_PARENT_RECEIPT:-}"
  echo "model=${LOYLY_PI_MODEL:-openai-codex/gpt-6.1-sol}"; echo "steer_dir=$L/steer"; echo "wrapper_pid=$$"
  echo "start=$(date -u +%FT%TZ)"; echo "cwd_before=$(pwd)"; } > "$L/launch.txt"
cp "$INSTR" "$L/instruction-as-handed.md"
mkdir -p "$L/steer"
export LOYLY_STEER_DIR="$L/steer"
cd "$ROOM" || exit 2
set -x
"$REPO/bin/loyly-clj" builder-host "$ROOM" "$INSTR" "$STORE" "$RID" "$PI_SETTINGS" \
  < /dev/null > "$L/pi.stdout" 2> "$L/pi.stderr" &
pid=$!
set +x
echo "host_pid=$pid" >> "$L/launch.txt"
# SIGTERM to the wrapper reaches the host, which aborts the run and closes the store.
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
wait "$pid"; rc=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; rc=$?; done
# What the builder had to install, for the image's Dockerfile (loyly.builder-host, IMAGE_ADDITIONS):
# the room's .builder/, outside APP_DIR, so the candidate digest never covers it.
[[ -f "$ROOM/.builder/image-additions.txt" ]] && cp "$ROOM/.builder/image-additions.txt" "$L/image-additions.txt"
{ echo "end=$(date -u +%FT%TZ)"; echo "exit=$rc"; } >> "$L/launch.txt"
exit $rc
