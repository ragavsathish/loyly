#!/usr/bin/env python3
"""Build a public playback of cycle-25 grading on the spec event storm.

Only explicitly selected trace fields and the extracted Grain event-type timeline
enter the page. Evidence files are read-only inputs; this is a visualization,
not a new score or a single cycle-runner-store replay.
"""

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "harness/v2/cycles/06/25"
OUTPUT = ROOT / "tools/spec/replay/cycle-25-grading.html"


def read(name):
    return json.loads((EVIDENCE / name).read_text())


def attributes(record):
    return {a["key"]: next(iter(a["value"].values())) for a in record.get("attributes", [])}


def main():
    trace = read("profile.traces.otlp.json")
    profile = read("profile.json")
    scores = read("scores.json")
    spans = [
        span
        for resource in trace["resourceSpans"]
        for scope in resource["scopeSpans"]
        for span in scope["spans"]
    ]
    grade_spans = [span for span in spans if span["name"] == "loyly.grade.item"]
    score_by_id = {item["id"]: item for item in scores["items"]}
    profile_by_id = {case["id"]: case for case in profile["cases"]}
    assert len(grade_spans) == len(score_by_id) == len(profile_by_id) == 61
    assert profile["status"] == "failed" and profile["verdicts"]["pass_count"] == 61
    base_time = min(int(span["startTimeUnixNano"]) for span in spans)
    cases = []
    events = []
    allowed = {
        "loyly.profile.phase", "loyly.vm.qemu.count", "loyly.process.count",
        "loyly.grain.events", "loyly.orc.traces", "loyly.orc.nodes",
        "loyly.judge.scores", "loyly.orc.sheet", "loyly.orc.status",
        "loyly.orc.duration.ms", "loyly.orc.node", "loyly.orc.executions",
        "loyly.orc.total_tokens", "loyly.jvm.command", "loyly.jvm.status",
    }
    for span in grade_spans:
        attrs = attributes(span)
        item_id = attrs["loyly.item.id"]
        score = score_by_id[item_id]
        case = profile_by_id[item_id]
        assert score["verdict"] == "pass" and case["status"] == "clean"
        cases.append({
            "id": item_id, "name": score["name"], "verdict": score["verdict"],
            "profile": case["status"], "model": case["model_requests"],
            "qemu": case["peak_observed_qemu"], "grain": case["grain_profiles"],
            "elapsed": case["elapsed_ms"], "events": len(span.get("events", [])),
        })
        for index, event in enumerate(span.get("events", [])):
            event_attrs = attributes(event)
            if event["name"] == "loyly.profile.mark":
                mark_name = event_attrs.get("loyly.mark.name")
                if mark_name not in {"run-id", "trace-id", "model-requests"}:
                    continue
                detail = {"mark": mark_name}
                if mark_name == "model-requests":
                    detail["count"] = int(event_attrs["loyly.mark.value"])
            else:
                detail = {key.removeprefix("loyly."): value for key, value in event_attrs.items() if key in allowed}
            events.append({
                "t": (int(event["timeUnixNano"]) - base_time) // 1_000_000,
                "id": item_id, "kind": event["name"].removeprefix("loyly."),
                "detail": detail, "order": index,
            })
    assert len(events) >= 3000
    events.sort(key=lambda event: (event["t"], event["id"], event["order"]))
    for event in events:
        del event["order"]
    cases.sort(key=lambda case: case["id"])
    grain = json.loads((ROOT / "tools/spec/replay/src/replay/cycle-25-grain-events.json").read_text())
    assert set(grain["cases"]) == set(score_by_id)
    assert sum(map(len, grain["cases"].values())) == 1910
    story_svg = (ROOT / "tools/spec/views/dist/story.svg").read_text().split("?>", 1)[1].strip()
    story_events = set(re.findall(r'data-event="([^"]+)"', story_svg))
    assert len(story_events) == 25
    story_svg = story_svg.replace('href="#', 'href="../index.html#')
    data = {"cases": cases, "events": events, "status": profile["status"],
            "problem": profile["problems"][0], "trace": profile["otel_trace_id"],
            "grain": grain["cases"]}
    data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    data_json = data_json.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    template = (Path(__file__).parent / "src/replay/grading-template.html").read_text()
    base_css = (ROOT / "tools/spec/views/src/specviews/page.css").read_text()
    replay_css = (ROOT / "tools/spec/replay/src/replay/page.css").read_text()
    page = (template.replace("BASE_CSS", base_css)
                    .replace("REPLAY_CSS", replay_css)
                    .replace("STORY_SVG", story_svg)
                    .replace("DATA_JSON", data_json))
    OUTPUT.write_text(page)
    print(f"{OUTPUT}: {len(cases)} cases, {len(events)} recorded trace events")


if __name__ == "__main__":
    main()
