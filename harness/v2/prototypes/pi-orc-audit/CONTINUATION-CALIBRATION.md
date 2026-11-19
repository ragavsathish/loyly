# Same-session continuation calibration

The legacy `harness/regen.clj` `carry-slice!` loop continues a slice builder on its own
uncarried IDs before gate, at most three times, and stops when the candidate does not change.
The original Löyly Pi overlay now uses durable `maybe-continue` and `continue` phases for
the same rule. Each continuation is a new request ID on the existing attempt's Pi session
store; a gate failure still creates a separate repair attempt.

On 2026-11-19, an isolated `openai-codex/gpt-6.1-sol` Pi/Gondolin calibration used the
provided `builder.sh` twice on one room. Request `pi-continuation-calibration` wrote
`first.txt` containing `first turn`; request `pi-continuation-calibration-c1` reopened the
same SQLite session store and wrote `second.txt` containing `second turn`, preserving the
first file. Both launch receipts recorded session ID `pi-continuation-calibration`, distinct
request IDs, the same store path, the same model, and exit 0. The final local store SHA-256 is
`4b5b6c74c0d3a27616f43868a6224f61e060b49e46076f72d64455c404685ecc`. Raw room,
store and launch records are in ignored `scratch-pi-continuation-calibration/`.

Controller fixture cycles then exercised two selected uncarried IDs, stopping after an
unchanged turn, and stopping at three turns while retaining the remaining IDs. Every fixture
gate followed its continuation audit. A controller SIGKILL during the first continuation
left the wrapper running; the restarted controller joined that request's receipt and then
completed the second turn, with exactly three launch records (initial, c1, c2). These are
process and scheduling calibrations, not a
product score. The real approved cut still needs a fresh builder, gate, grader and score.
