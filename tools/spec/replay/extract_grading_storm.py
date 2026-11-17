#!/usr/bin/env python3
"""Extract public event-type timelines from cycle-25's preserved Grain stores.

Run on the machine retaining .pi/harness/.state/grading/06-c25/work. The output
contains only relative time and domain event type, no Fressian payload or host path.
The checked-in JSON lets the published playback rebuild without the private stores.
"""

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / ".pi/harness/.state/grading/06-c25/work"
OUTPUT = ROOT / "tools/spec/replay/src/replay/cycle-25-grain-events.json"
SCORES = ROOT / "harness/v2/cycles/06/25/scores.json"


def main():
    expected = {item["id"] for item in json.loads(SCORES.read_text())["items"]}
    files = sorted(path for path in WORK.glob("06-*/events.sqlite")
                   if re.fullmatch(r"06-\d{3}", path.parent.name))
    assert {path.parent.name for path in files} == expected, "canonical store set differs from score"
    cases = {}
    for path in files:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = db.execute("""select time,type from events
                where type not like ':grain/%' and type not like ':sheet/%'
                order by time,id""").fetchall()
        finally:
            db.close()
        start = datetime.fromisoformat(rows[0][0].replace("Z", "+00:00")) if rows else None
        events = []
        for time, event_type in rows:
            assert re.fullmatch(r":[a-z][a-z0-9-]*/[a-z][a-z0-9-]*", event_type), event_type
            elapsed = datetime.fromisoformat(time.replace("Z", "+00:00")) - start
            events.append([int(elapsed.total_seconds() * 1000), event_type[1:]])
        cases[path.parent.name] = events
    OUTPUT.write_text(json.dumps({"version": 1, "source": "cycle-25 canonical grader Grain stores",
                                  "cases": cases}, separators=(",", ":")) + "\n")
    print(f"{OUTPUT}: {len(cases)} stores, {sum(map(len, cases.values()))} domain events, "
          f"{sum(not events for events in cases.values())} with no domain event")


if __name__ == "__main__":
    main()
