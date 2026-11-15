# Cycle 17 gate shadow, 2026-11-15

The cycle 17 candidate (`.pi/harness/.state/rooms/06-c17/harness-impl/06-cycle-runner/`)
was compared with the archived legacy `verify.sh` on the same HTTP candidate files.
The scratch project was cut from `6d42c8e`, with `harness/` replaced by
`archive/legacy-harness/`. The historical scratch commit `249a90b` cited in the
decisions record is not present in this clone, so this is a new, narrower gate
comparison rather than a replay of the five switch shadow runs.

The scratch harness oracle passed `check.sh --local`. Its `verify.sh` SHA-256 was
`ee1e72df898e22286f49cc319c7a96aa49cacba2ec2059cf801f9a3e7d7ce795`.
The app was a static HTTP fixture with a passing `test.sh`, `start.sh PORT` using
Python's HTTP server, and the legacy sauna marker probe. The runner's builder
adapter copied the same `impl/` files into its fenced room; byte comparison of
all four generated files succeeded for the good version, and a directory
comparison succeeded for the bad version.
The three executable/served fixture files and the one-line bad variant are kept
under `fixture/`; the fourth file was the cut's unchanged `impl/README.md`.

| Scratch cut | Candidate | Legacy `verify.sh` | Cycle 17 gate |
|---|---|---|---|
| `45ee37f`, `impl` tree `357bb59f7716fb5d407bf9bcc86bc8b46319ebf7` | sauna marker | pass, answered on poll 2 of 20; 18 polls unused | pass, `BOOT 20 10`, `ANSWERED 2`, same probe text; candidate digest `sha256:25863b60f5b3b3d206acdc21612a6aebc475071c6397696585ff7527588d9b95` |
| `ff9e83f`, `impl` tree `8b9afa26a59899c07b003239a4d93cdb994a1f59` | wrong marker | fail after boot: page does not serve the app | fail after boot: `identity-probe-failed The served page did not carry the application marker`; candidate digest `sha256:fa880a40c983a50163259c24f0c1ec13d1dc84f445c1647e671099e755a7a012` |

The runner was given no `LOYLY_GRADER_IMAGE`, so both runs stopped at grading
after the gate result. This isolates the gate comparison. It does not compare
the full fence, checklist, grader, score or scoreboard stages and does not
satisfy the instrument exception alone. Cycle 17's failed profile also still
blocks acceptance. Raw scratch logs and stores remain under ignored
`.pi/harness/.state/shadow/` in this checkout.
