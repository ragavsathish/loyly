# Builder claim

Selected checklist SHA-256: `06f0dba7ba9aa07152950cd0bc6c38560f6c6b95a3fa88354909a4561434dda2`.

Implemented the 47 selected scenarios across all five ready-for-development slices. `test.mjs` has 48 HTTP tests naming the selected item IDs, including 100 overlapping standing-slot races and a family-time cap variant for transferred occurrences. The initial missing-server run is recorded in `red.log`; the additional cap regression's failing run is in `cap-red.log`; the final 48/48 run is in `green.log`.

Files delivered: `server.mjs`, `index.html`, `contract.json`, `start.sh`, `test.sh`, `test.mjs`, `README.md`, `.gitignore`, `UNCARRIED.md`, this report, and the three test logs. All writes were under `impl/`.

Verification: `impl/test.sh` passed 48 tests; `impl/start.sh 8901` served HTTP 200 carrying “sauna”; `harness/probe.sh http://127.0.0.1:8901` passed. Both server and served browser script passed syntax checks. A separate live persistence check booked a slot, restarted the server with the same record, and confirmed the holding plus list and billing survived. The final start/probe used a fresh default record. Servers were stopped and runtime data was removed before delivery.

Known uncarried product items: none (`UNCARRIED.md` is empty). The automated @item-01-011 check replays fields parsed from the actual derived refusal against fresh state; the independent blind judge and separate replay are owned by the operator/gate and remain pending. This is a builder claim, not an independent acceptance decision.

Obstacle: local browser automation is disabled in Work settings. Browser visual QA could not be performed; served HTML, JavaScript syntax, HTTP workflows and derived responses were checked. The app is a local operator console with explicit acting-role inputs, not an authenticated multi-user deployment. Dates and instants use UTC; equipment control and payment collection remain outside the selected scope.
