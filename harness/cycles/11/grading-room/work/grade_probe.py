#!/usr/bin/env python3
"""Black-box HTTP grader. Talks only to a copied candidate started with start.sh."""

import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

ROOM = Path("/tmp/loyly-cursor-cycle-11/grading-room")
IMPL = ROOM / "impl"
WORK = ROOM / "work"
ITEMS = WORK / "items"
RESULTS = WORK / "allure-results"
RUNTIMES = WORK / "runtimes"

SLOT = {
    "weekday": "Tuesday",
    "startTime": "17:00",
    "endTime": "18:30",
    "dressingRoom": "pukuhuone 8",
}

OPEN_SLOTS = [
    ("pukuhuone 8", "Tuesday", "17:00"),
    ("pukuhuone 8", "Thursday", "17:00"),
    ("pukuhuone 9", "Thursday", "17:00"),
    ("pukuhuone 9", "Friday", "17:00"),
    ("pukuhuone 9", "Saturday", "17:00"),
]


def now_ms():
    return int(time.time() * 1000)


class App:
    def __init__(self, item_id, port):
        self.item_id = item_id
        self.port = port
        self.runtime = RUNTIMES / item_id
        self.item_dir = ITEMS / item_id
        self.item_dir.mkdir(parents=True, exist_ok=True)
        self.proc = None
        self.logf = None
        self.transcript = []

    def start(self):
        if self.runtime.exists():
            shutil.rmtree(self.runtime)
        shutil.copytree(IMPL, self.runtime, symlinks=True)
        log_path = self.item_dir / "start.log"
        self.logf = open(log_path, "a", encoding="utf-8")
        self.logf.write(f"command: ./start.sh {self.port}\n")
        self.logf.flush()
        self.proc = subprocess.Popen(
            ["./start.sh", str(self.port)],
            cwd=self.runtime,
            stdout=self.logf,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + 20
        last = ""
        while time.time() < deadline:
            if self.proc.poll() is not None:
                self.logf.flush()
                raise RuntimeError(
                    f"start.sh exited {self.proc.returncode} before readiness; see {log_path}"
                )
            code, body = self._raw("GET", "/api/schedule")
            last = f"{code} {body[:120]!r}"
            if code == 200:
                self.logf.write("ready: GET /api/schedule 200\n")
                self.logf.flush()
                return
            time.sleep(0.05)
        raise RuntimeError(f"not ready within 20s ({last})")

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait(timeout=3)
        if self.logf is not None and not self.logf.closed:
            self.logf.write("stopped\n")
            self.logf.close()
        self.proc = None

    def _raw(self, method, path, payload=None, timeout=5):
        body = None if payload is None else json.dumps(payload).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            headers = {"Accept": "application/json, text/html;q=0.8"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, data
        except Exception as exc:
            return 0, str(exc).encode()
        finally:
            conn.close()

    def request(self, method, path, payload=None):
        started = now_ms()
        status, data = self._raw(method, path, payload)
        text = data.decode("utf-8", "replace")
        parsed = None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        entry = {
            "t": started,
            "method": method,
            "path": path,
            "request": payload,
            "status": status,
            "response_text": text,
            "response_json": parsed,
        }
        self.transcript.append(entry)
        return entry

    def save_transcript(self):
        path = self.item_dir / "transcript.json"
        path.write_text(json.dumps(self.transcript, indent=2), encoding="utf-8")
        log = self.item_dir / "command.log"
        lines = [f"probe item {self.item_id} port {self.port}"]
        for entry in self.transcript:
            lines.append(
                f"\n--- {entry['method']} {entry['path']} -> {entry['status']}"
            )
            if entry["request"] is not None:
                lines.append("request: " + json.dumps(entry["request"]))
            lines.append(entry["response_text"])
        log.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path


def schedule_of(app):
    entry = app.request("GET", "/api/schedule")
    if entry["status"] != 200 or not isinstance(entry["response_json"], dict):
        raise RuntimeError(f"schedule unreadable: {entry['status']} {entry['response_text'][:300]}")
    return entry["response_json"]


def slot_of(schedule, room, weekday):
    room_obj = schedule["dressingRooms"][room]
    day = room_obj["days"][weekday]
    return room_obj, day


def holders(schedule):
    found = []
    for room, info in schedule["dressingRooms"].items():
        for weekday, day in info["days"].items():
            for slot in day.get("slots") or []:
                if slot.get("heldBy"):
                    found.append(
                        {
                            "dressingRoom": room,
                            "weekday": weekday,
                            "startTime": slot.get("startTime"),
                            "endTime": slot.get("endTime"),
                            "heldBy": slot.get("heldBy"),
                            "bookable": slot.get("bookable"),
                        }
                    )
    return found


def free_slots(schedule):
    found = []
    for room, info in schedule["dressingRooms"].items():
        for weekday, day in info["days"].items():
            for slot in day.get("slots") or []:
                if slot.get("heldBy") in (None, "") and slot.get("bookable") is True:
                    found.append(
                        {
                            "dressingRoom": room,
                            "weekday": weekday,
                            "startTime": slot.get("startTime"),
                            "endTime": slot.get("endTime"),
                        }
                    )
    return found


def holds_for(schedule, apartment):
    return [h for h in holders(schedule) if str(h["heldBy"]) == str(apartment)]


def request_slot(app, apartment, room, weekday, start):
    return app.request(
        "POST",
        "/api/standing-slot/request",
        {
            "apartment": str(apartment),
            "weekday": weekday,
            "startTime": start,
            "dressingRoom": room,
        },
    )


def give_up(app, apartment, room, weekday, start):
    return app.request(
        "POST",
        "/api/standing-slot/give-up",
        {
            "apartment": str(apartment),
            "weekday": weekday,
            "startTime": start,
            "dressingRoom": room,
        },
    )


def views(app):
    listed = app.request("GET", "/api/views/slot-list")
    heater = app.request("GET", "/api/views/heater")
    billing = app.request("GET", "/api/views/billing")
    return listed, heater, billing


def is_confirmed(entry):
    body = entry.get("response_json")
    return (
        isinstance(body, dict)
        and body.get("ok") is True
        and isinstance(body.get("booking"), dict)
    )


def is_refused(entry):
    body = entry.get("response_json")
    return isinstance(body, dict) and body.get("ok") is False


def refusal_because_held(entry):
    body = entry.get("response_json") or {}
    message = str(body.get("message") or "")
    reason = str(body.get("reason") or "")
    return reason == "held" or "already held" in message.lower() or "slot is held" in message.lower()


def day_summary(schedule):
    summary = {}
    for room, info in schedule["dressingRooms"].items():
        days = {}
        for weekday, day in info["days"].items():
            days[weekday] = {
                "noSlots": day.get("noSlots"),
                "slots": day.get("slots"),
            }
        summary[room] = {"saunaDays": info.get("saunaDays"), "days": days}
    return summary


def race_once(app):
    """Send both standing-slot requests before either response is read."""
    port = app.port
    payload = {
        "weekday": "Tuesday",
        "startTime": "17:00",
        "dressingRoom": "pukuhuone 8",
    }
    start_barrier = threading.Barrier(2)
    sent_barrier = threading.Barrier(2)
    out = {}

    def worker(apartment):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.connect()
            body = json.dumps({"apartment": apartment, **payload}).encode()
            start_barrier.wait(timeout=5)
            t_send = time.perf_counter()
            conn.request(
                "POST",
                "/api/standing-slot/request",
                body=body,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
            t_sent = time.perf_counter()
            sent_barrier.wait(timeout=5)
            t_read = time.perf_counter()
            resp = conn.getresponse()
            raw = resp.read()
            t_done = time.perf_counter()
            text = raw.decode("utf-8", "replace")
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = None
            out[apartment] = {
                "apartment": apartment,
                "status": resp.status,
                "response_text": text,
                "response_json": parsed,
                "t_send": t_send,
                "t_sent": t_sent,
                "t_read": t_read,
                "t_done": t_done,
                "error": None,
            }
        except Exception as exc:
            out[apartment] = {
                "apartment": apartment,
                "status": 0,
                "response_text": "",
                "response_json": None,
                "error": f"{type(exc).__name__}: {exc}",
            }
        finally:
            conn.close()

    threads = [
        threading.Thread(target=worker, args=("12",)),
        threading.Thread(target=worker, args=("3",)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=8)
    for apartment in ("12", "3"):
        result = out.get(apartment)
        if result is None:
            result = {
                "apartment": apartment,
                "status": 0,
                "response_text": "",
                "response_json": None,
                "error": "worker did not finish",
            }
            out[apartment] = result
        app.transcript.append(
            {
                "t": now_ms(),
                "method": "POST",
                "path": "/api/standing-slot/request",
                "request": {"apartment": apartment, **payload},
                "status": result["status"],
                "response_text": result["response_text"] or result["error"] or "",
                "response_json": result["response_json"],
                "race": {
                    "t_send": result.get("t_send"),
                    "t_sent": result.get("t_sent"),
                    "t_read": result.get("t_read"),
                    "t_done": result.get("t_done"),
                    "error": result.get("error"),
                },
            }
        )
    a = out["12"]
    b = out["3"]
    overlap = (
        a.get("error") is None
        and b.get("error") is None
        and a.get("t_read") is not None
        and b.get("t_read") is not None
        and a["t_read"] >= a["t_sent"]
        and b["t_read"] >= b["t_sent"]
        and a["t_read"] >= b["t_sent"]
        and b["t_read"] >= a["t_sent"]
    )
    return a, b, overlap


def release_tuesday(app):
    schedule = schedule_of(app)
    listed, _, billing = views(app)
    names = set()
    for hold in holders(schedule):
        if (
            hold["dressingRoom"] == "pukuhuone 8"
            and hold["weekday"] == "Tuesday"
            and hold["startTime"] == "17:00"
        ):
            names.add(str(hold["heldBy"]))
    body = listed.get("response_json") or {}
    for slot in body.get("slots") or []:
        if (
            slot.get("dressingRoom") == "pukuhuone 8"
            and slot.get("weekday") == "Tuesday"
            and str(slot.get("time", "")).startswith("17:00")
        ):
            names.add(str(slot.get("apartment")))
    bill = billing.get("response_json") or {}
    for charge in bill.get("activeCharges") or []:
        if (
            charge.get("dressingRoom") == "pukuhuone 8"
            and charge.get("weekday") == "Tuesday"
            and charge.get("startTime") == "17:00"
        ):
            names.add(str(charge.get("payer")))
    for name in sorted(names):
        if name and name != "None":
            give_up(app, name, "pukuhuone 8", "Tuesday", "17:00")
    schedule = schedule_of(app)
    room, day = slot_of(schedule, "pukuhuone 8", "Tuesday")
    slots = day.get("slots") or []
    free = bool(slots) and all(slot.get("heldBy") in (None, "") for slot in slots)
    return free, schedule


def classify_race(a, b):
    confirmed = [x for x in (a, b) if is_confirmed(x)]
    refused = [x for x in (a, b) if is_refused(x)]
    if len(confirmed) == 2:
        bucket = "both_confirmed"
    elif len(confirmed) == 0:
        bucket = "neither_confirmed"
    elif len(confirmed) == 1:
        bucket = "one_confirmed"
    else:
        bucket = "other"
    loser_held = True
    if len(confirmed) == 1:
        loser = b if confirmed[0] is a else a
        loser_held = refusal_because_held(loser)
    winner = confirmed[0]["apartment"] if len(confirmed) == 1 else None
    return {
        "bucket": bucket,
        "confirmed_apartments": [x["apartment"] for x in confirmed],
        "refused_apartments": [x["apartment"] for x in refused],
        "loser_refused_because_held": loser_held if len(confirmed) == 1 else None,
        "winner": winner,
        "clean_exactly_one": bucket == "one_confirmed" and loser_held is True,
    }


def count_slot_claims(listed, heater, billing):
    body = listed.get("response_json") or {}
    list_hits = [
        slot
        for slot in body.get("slots") or []
        if slot.get("dressingRoom") == "pukuhuone 8"
        and slot.get("weekday") == "Tuesday"
        and str(slot.get("time", "")).startswith("17:00")
    ]
    heat = heater.get("response_json") or {}
    heat_hits = [
        row
        for row in heat.get("schedule") or []
        if row.get("dressingRoom") == "pukuhuone 8"
        and row.get("weekday") == "Tuesday"
        and row.get("heatFrom") == "17:00"
    ]
    bill = billing.get("response_json") or {}
    charge_hits = [
        row
        for row in bill.get("activeCharges") or []
        if row.get("dressingRoom") == "pukuhuone 8"
        and row.get("weekday") == "Tuesday"
        and row.get("startTime") == "17:00"
    ]
    return list_hits, heat_hits, charge_hits


def observe_race_outcome(app, a, b, overlap):
    schedule = schedule_of(app)
    listed, heater, billing = views(app)
    holds = [
        h
        for h in holders(schedule)
        if h["dressingRoom"] == "pukuhuone 8"
        and h["weekday"] == "Tuesday"
        and h["startTime"] == "17:00"
    ]
    list_hits, heat_hits, charge_hits = count_slot_claims(listed, heater, billing)
    payers = {str(row.get("payer")) for row in charge_hits}
    list_apartments = {str(row.get("apartment")) for row in list_hits}
    classification = classify_race(a, b)
    two_holders = (
        len(holds) > 1
        or len(list_hits) > 1
        or len(set(list_apartments)) > 1
        or len(heat_hits) > 1
        or len(payers) > 1
        or len(charge_hits) > 1
    )
    schedule_holder = holds[0]["heldBy"] if len(holds) == 1 else None
    agrees = (
        len(holds) == 1
        and len(list_hits) == 1
        and len(heat_hits) == 1
        and len(charge_hits) == 1
        and str(list_hits[0].get("apartment")) == str(schedule_holder)
        and str(charge_hits[0].get("payer")) == str(schedule_holder)
        and heat_hits[0].get("heatTo") == "18:30"
    )
    return {
        "overlap": overlap,
        "classification": classification,
        "schedule_holds": holds,
        "list_hits": list_hits,
        "heat_hits": heat_hits,
        "charge_hits": charge_hits,
        "two_holders_in_a_view": two_holders,
        "views_agree_on_one_holder": agrees,
        "listed_status": listed["status"],
        "heater_status": heater["status"],
        "billing_status": billing["status"],
    }


def kill_listeners():
    # Stop the discovery server and any leftover candidate processes in this room.
    subprocess.run(
        ["tmux", "-f", "/exec-daemon/tmux.portal.conf", "kill-session", "-t", "loyly-discover"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["pkill", "-f", "/tmp/loyly-cursor-cycle-11/grading-room/work/runtimes"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.2)


def run_item(item_id, port, fn):
    app = App(item_id, port)
    started = now_ms()
    try:
        app.start()
        result = fn(app)
    except Exception as exc:
        result = {
            "status": "failed",
            "message": f"not reached: probe failed before the scenario could be observed ({type(exc).__name__}: {exc})",
            "steps": [
                {
                    "name": "Given a fresh candidate copy is serving HTTP",
                    "status": "failed",
                    "stage": "finished",
                    "statusDetails": {
                        "message": f"not reached: {type(exc).__name__}: {exc}"
                    },
                }
            ],
            "surprises": [],
            "attachment_text": f"probe error: {type(exc).__name__}: {exc}\n",
            "attachment_ext": "txt",
            "attachment_type": "text/plain",
        }
    finally:
        try:
            app.save_transcript()
        except Exception:
            pass
        app.stop()
    result["start"] = started
    result["stop"] = now_ms()
    if result["stop"] < result["start"]:
        result["stop"] = result["start"]
    result["item_dir"] = str(app.item_dir)
    return result


def step(name, status, message):
    return {
        "name": name,
        "status": status,
        "stage": "finished",
        "statusDetails": {"message": message},
    }


def grade_001(app):
    page = app.request("GET", "/")
    schedule = schedule_of(app)
    html = page["response_text"]
    embedded = None
    marker = '<pre id="schedule">'
    if marker in html and "</pre>" in html:
        raw = html.split(marker, 1)[1].split("</pre>", 1)[0]
        try:
            embedded = json.loads(raw)
        except json.JSONDecodeError:
            embedded = None
    observed = embedded if isinstance(embedded, dict) else None
    api_summary = day_summary(schedule)
    page_summary = day_summary(observed) if observed else None
    ph9_days = (observed or schedule)["dressingRooms"]["pukuhuone 9"]["saunaDays"]
    ph8_days = (observed or schedule)["dressingRooms"]["pukuhuone 8"]["saunaDays"]
    source = observed or schedule
    tue8 = source["dressingRooms"]["pukuhuone 8"]["days"]["Tuesday"]
    tue9 = source["dressingRooms"]["pukuhuone 9"]["days"]["Tuesday"]
    bookable_8 = [
        slot
        for slot in tue8.get("slots") or []
        if slot.get("bookable") is True and slot.get("heldBy") in (None, "")
    ]
    no_slots_9 = tue9.get("noSlots") is True and not (tue9.get("slots") or [])
    given_9 = ph9_days == ["Thursday", "Friday", "Saturday"]
    given_8 = "Tuesday" in ph8_days
    views_match = page_summary == api_summary
    passed = given_9 and given_8 and bool(bookable_8) and no_slots_9 and views_match and page["status"] == 200
    steps = [
        step(
            "Given pukuhuone 9's sauna days are Thursday, Friday and Saturday",
            "passed" if given_9 else "failed",
            f"Inspected pukuhuone 9 separately. saunaDays={ph9_days}.",
        ),
        step(
            "And pukuhuone 8's sauna days include Tuesday",
            "passed" if given_8 else "failed",
            f"Inspected pukuhuone 8 separately. saunaDays={ph8_days}.",
        ),
        step(
            "When a resident views the weekly schedule for sauna F",
            "passed" if page["status"] == 200 and observed else "failed",
            f"GET / -> {page['status']}, embedded schedule parsed={observed is not None}, sauna={(source.get('sauna'))}. GET /api/schedule agrees={views_match}.",
        ),
        step(
            "Then Tuesday shows bookable slots for pukuhuone 8",
            "passed" if bookable_8 else "failed",
            f"Tuesday pukuhuone 8 noSlots={tue8.get('noSlots')} bookable slots={bookable_8}.",
        ),
        step(
            "And Tuesday shows no slots for pukuhuone 9",
            "passed" if no_slots_9 else "failed",
            f"Tuesday pukuhuone 9 noSlots={tue9.get('noSlots')} slots={tue9.get('slots')}.",
        ),
    ]
    message = (
        "Request: GET / (weekly schedule for sauna F) and GET /api/schedule. "
        f"Observed pukuhuone 9 sauna days {ph9_days}; pukuhuone 8 sauna days {ph8_days}. "
        f"Tuesday pukuhuone 8 bookable slots={bookable_8}; Tuesday pukuhuone 9 slots={tue9.get('slots')} noSlots={tue9.get('noSlots')}. "
        f"Page and API schedules agree={views_match}. Consequence: resident schedule {'matches' if passed else 'does not match'} both Tuesday assertions."
    )
    attachment = {
        "html_status": page["status"],
        "per_room": page_summary or api_summary,
        "api_schedule": api_summary,
        "page_and_api_agree": views_match,
        "tuesday_pukuhuone_8": tue8,
        "tuesday_pukuhuone_9": tue9,
    }
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": []
        if views_match
        else [
            {
                "observation": "The HTML weekly schedule and GET /api/schedule did not contain the same per-room days.",
                "evidence_file": "items/01-001/transcript.json",
            }
        ],
        "attachment_text": json.dumps(attachment, indent=2),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_002(app):
    schedule = schedule_of(app)
    per_room = day_summary(schedule)
    ph9 = per_room["pukuhuone 9"]["saunaDays"]
    given = ph9 == ["Thursday", "Friday", "Saturday"]
    response = request_slot(app, "12", "pukuhuone 9", "Tuesday", "17:00")
    body = response.get("response_json") or {}
    message_text = str(body.get("message") or "")
    open_days = body.get("openDays")
    refused = is_refused(response) and body.get("reason") == "closed_day"
    names_closed = "pukuhuone 9" in message_text and "Tuesday" in message_text and "no sauna day" in message_text
    names_open = all(day in message_text for day in ("Thursday", "Friday", "Saturday"))
    after = schedule_of(app)
    ph9_tue = after["dressingRooms"]["pukuhuone 9"]["days"]["Tuesday"]
    unchanged = ph9_tue.get("noSlots") is True and not (ph9_tue.get("slots") or [])
    held = holds_for(after, "12")
    passed = given and refused and names_closed and names_open and unchanged and held == []
    steps = [
        step(
            "Given pukuhuone 9's sauna days are Thursday, Friday and Saturday",
            "passed" if given else "failed",
            f"Inspected pukuhuone 9 saunaDays={ph9}. pukuhuone 8 saunaDays={per_room['pukuhuone 8']['saunaDays']}.",
        ),
        step(
            "When the household in apartment 12 requests a standing slot on Tuesday at 17:00 in pukuhuone 9",
            "passed" if response["status"] else "failed",
            f"POST /api/standing-slot/request {response['request']} -> {response['status']} {message_text}",
        ),
        step(
            "Then the request is refused because pukuhuone 9 has no sauna day on Tuesday",
            "passed" if refused and names_closed else "failed",
            f"Exact refusal text: {message_text}",
        ),
        step(
            "And the refusal names the days pukuhuone 9 does open",
            "passed" if names_open else "failed",
            f"Offered open days in the refusal text and openDays={open_days}.",
        ),
    ]
    message = (
        "Request: POST /api/standing-slot/request apartment 12, Tuesday 17:00, pukuhuone 9. "
        f"Observed status {response['status']} body {response['response_text']}. "
        f"Exact refusal text: {message_text}. Offered open days: {open_days}. "
        f"Consequence: refusal names the closed Tuesday and the open days={names_open}; no hold was stored for apartment 12 ({held})."
    )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps(
            {
                "per_room_before": per_room,
                "request": response["request"],
                "status": response["status"],
                "response": body,
                "exact_refusal_text": message_text,
                "offered_open_days": open_days,
                "holds_for_12_after": held,
            },
            indent=2,
        ),
        "attachment_ext": "json",
        "attachment_type": "application/json",
        "refusal_text": message_text,
    }


def grade_003(app):
    before = schedule_of(app)
    room, day = slot_of(before, "pukuhuone 8", "Tuesday")
    slots = day.get("slots") or []
    free = bool(slots) and all(
        slot.get("startTime") == "17:00" and slot.get("heldBy") in (None, "") and slot.get("bookable") is True
        for slot in slots
        if slot.get("startTime") == "17:00"
    ) and any(slot.get("startTime") == "17:00" for slot in slots)
    response = request_slot(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    body = response.get("response_json") or {}
    booking = body.get("booking") or {}
    confirmed = is_confirmed(response)
    window_ok = booking.get("startTime") == "17:00" and booking.get("endTime") == "18:30"
    after = schedule_of(app)
    holds = holds_for(after, "12")
    tuesday = [
        h
        for h in holds
        if h["dressingRoom"] == "pukuhuone 8" and h["weekday"] == "Tuesday" and h["startTime"] == "17:00"
    ]
    listed, _, _ = views(app)
    list_body = listed.get("response_json") or {}
    listed_hit = [
        slot
        for slot in list_body.get("slots") or []
        if str(slot.get("apartment")) == "12"
        and slot.get("dressingRoom") == "pukuhuone 8"
        and slot.get("weekday") == "Tuesday"
    ]
    repeats = str(body.get("repeats") or "") + " " + str(body.get("message") or "")
    every_tuesday = "every coming Tuesday" in repeats or "every Tuesday" in repeats
    persisted = len(tuesday) == 1 and len(listed_hit) == 1
    passed = free and confirmed and window_ok and persisted and every_tuesday
    steps = [
        step(
            "Given Tuesday at 17:00 in pukuhuone 8 is free",
            "passed" if free else "failed",
            f"Before request, Tuesday slots={slots}.",
        ),
        step(
            "When the household in apartment 12 requests a standing slot on Tuesday at 17:00 in pukuhuone 8",
            "passed" if response["status"] else "failed",
            f"POST /api/standing-slot/request -> {response['status']} {response['response_text']}",
        ),
        step(
            "Then the standing slot is confirmed for 17:00 to 18:30",
            "passed" if confirmed and window_ok else "failed",
            f"booking={booking}.",
        ),
        step(
            "And the household in apartment 12 holds it for every coming Tuesday",
            "passed" if persisted and every_tuesday else "failed",
            f"Re-read schedule holds={tuesday}; posted list={listed_hit}; repeats/message={repeats.strip()}.",
        ),
    ]
    message = (
        "Request: POST /api/standing-slot/request apartment 12 Tuesday 17:00 pukuhuone 8. "
        f"Observed {response['status']} {response['response_text']}. "
        f"Re-read schedule hold={tuesday} and posted list={listed_hit}. "
        f"Consequence: confirmed 17:00 to 18:30 and persisted as the Tuesday standing hold={persisted and every_tuesday}."
    )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps(
            {
                "before_tuesday": slots,
                "response": body,
                "status": response["status"],
                "reread_holds": holds,
                "reread_list": list_body,
            },
            indent=2,
        ),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_004(app):
    setup = request_slot(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    before = schedule_of(app)
    holds_before = holds_for(before, "12")
    given = is_confirmed(setup) and any(
        h["dressingRoom"] == "pukuhuone 8" and h["weekday"] == "Tuesday" and h["startTime"] == "17:00"
        for h in holds_before
    )
    response = request_slot(app, "3", "pukuhuone 8", "Tuesday", "17:00")
    body = response.get("response_json") or {}
    refused = is_refused(response) and refusal_because_held(response)
    after = schedule_of(app)
    holds_after = holds_for(after, "12")
    still = [
        h
        for h in holds_after
        if h["dressingRoom"] == "pukuhuone 8" and h["weekday"] == "Tuesday" and h["startTime"] == "17:00"
    ]
    others = [
        h
        for h in holders(after)
        if h["dressingRoom"] == "pukuhuone 8" and h["weekday"] == "Tuesday" and h["startTime"] == "17:00"
    ]
    passed = given and refused and len(still) == 1 and len(others) == 1 and str(others[0]["heldBy"]) == "12"
    surprises = []
    if "apartment" in str(body.get("message") or "").lower() or body.get("holder"):
        surprises.append(
            {
                "observation": (
                    "The held-slot refusal names the holding household, not only that the slot is held. "
                    f"message={body.get('message')!r} holder={body.get('holder')!r}."
                ),
                "evidence_file": "items/01-004/transcript.json",
            }
        )
    steps = [
        step(
            "Given the household in apartment 12 holds the Tuesday 17:00 standing slot in pukuhuone 8",
            "passed" if given else "failed",
            f"Setup response ok={is_confirmed(setup)}; re-read holds={holds_before}.",
        ),
        step(
            "When the household in apartment 3 requests a standing slot on Tuesday at 17:00 in pukuhuone 8",
            "passed" if response["status"] else "failed",
            f"POST /api/standing-slot/request apartment 3 -> {response['status']} {response['response_text']}",
        ),
        step(
            "Then the request is refused because the slot is held",
            "passed" if refused else "failed",
            f"reason={body.get('reason')} message={body.get('message')}",
        ),
        step(
            "And the household in apartment 12 still holds the slot",
            "passed" if len(still) == 1 and len(others) == 1 else "failed",
            f"Re-read Tuesday 17:00 pukuhuone 8 holders={others}.",
        ),
    ]
    message = (
        "Request: POST /api/standing-slot/request apartment 3 Tuesday 17:00 pukuhuone 8 after apartment 12 held it. "
        f"Observed {response['status']} {response['response_text']}. "
        f"Re-read holders={others}. Consequence: refused because held={refused}; apartment 12 still the only holder={len(still)==1 and len(others)==1}."
    )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": surprises,
        "attachment_text": json.dumps(
            {
                "setup": setup.get("response_json"),
                "conflict_status": response["status"],
                "conflict_response": body,
                "holders_after": others,
            },
            indent=2,
        ),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_005(app):
    first = request_slot(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    mid = schedule_of(app)
    first_holds = holds_for(mid, "12")
    free = free_slots(mid)
    given = is_confirmed(first) and len(first_holds) == 1 and len(free) >= 1
    remaining = [
        slot
        for slot in free
        if not (
            slot["dressingRoom"] == "pukuhuone 8"
            and slot["weekday"] == "Tuesday"
            and slot["startTime"] == "17:00"
        )
    ]
    target = remaining[0] if remaining else {"dressingRoom": "pukuhuone 9", "weekday": "Friday", "startTime": "17:00"}
    second = request_slot(
        app, "12", target["dressingRoom"], target["weekday"], target["startTime"]
    )
    after = schedule_of(app)
    holds = holds_for(after, "12")
    listed, _, _ = views(app)
    list_body = listed.get("response_json") or {}
    listed_for_12 = [
        slot for slot in list_body.get("slots") or [] if str(slot.get("apartment")) == "12"
    ]
    confirmed = is_confirmed(second)
    booking = (second.get("response_json") or {}).get("booking") or {}
    persisted_second = any(
        h["dressingRoom"] == target["dressingRoom"]
        and h["weekday"] == target["weekday"]
        and h["startTime"] == target["startTime"]
        for h in holds
    )
    passed = given and confirmed and persisted_second and len(holds) == 2 and len(listed_for_12) == 2
    steps = [
        step(
            "Given the household in apartment 12 holds one standing slot",
            "passed" if is_confirmed(first) and len(first_holds) == 1 else "failed",
            f"Re-read after the first confirmation: {first_holds}.",
        ),
        step(
            "And free standing slots remain in the weekly schedule",
            "passed" if len(free) >= 1 else "failed",
            f"Free slots before the second request: {free}.",
        ),
        step(
            "When the household in apartment 12 requests a second standing slot on a free open slot",
            "passed" if second["status"] else "failed",
            f"POST second slot {target} -> {second['status']} {second['response_text']}",
        ),
        step(
            "Then the second standing slot is confirmed",
            "passed" if confirmed and persisted_second else "failed",
            f"booking={booking}; re-read contains target={persisted_second}.",
        ),
        step(
            "And the household in apartment 12 holds two standing slots",
            "passed" if len(holds) == 2 and len(listed_for_12) == 2 else "failed",
            f"Re-read schedule holds={holds}; posted list for 12={listed_for_12}.",
        ),
    ]
    message = (
        f"Request: POST /api/standing-slot/request apartment 12 {target}. "
        f"Observed {second['status']} {second['response_text']}. "
        f"Re-read holds={holds}; posted list count for apartment 12={len(listed_for_12)}. "
        f"Consequence: second slot persisted and household holds two={len(holds)==2 and persisted_second}."
    )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps(
            {
                "free_before_second": free,
                "second_request": second["request"],
                "second_status": second["status"],
                "second_response": second.get("response_json"),
                "holds_after": holds,
                "posted_list": list_body,
            },
            indent=2,
        ),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_006(app):
    first = request_slot(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    fillers = []
    others = [
        ("3", "pukuhuone 8", "Thursday", "17:00"),
        ("4", "pukuhuone 9", "Thursday", "17:00"),
        ("5", "pukuhuone 9", "Friday", "17:00"),
        ("6", "pukuhuone 9", "Saturday", "17:00"),
    ]
    filler_ok = True
    for apartment, room, weekday, start in others:
        entry = request_slot(app, apartment, room, weekday, start)
        fillers.append({"request": entry["request"], "status": entry["status"], "body": entry.get("response_json")})
        filler_ok = filler_ok and is_confirmed(entry)
    mid = schedule_of(app)
    free = free_slots(mid)
    holds_mid = holds_for(mid, "12")
    given_one = is_confirmed(first) and len(holds_mid) == 1
    given_full = free == [] and filler_ok
    second = request_slot(app, "12", "pukuhuone 9", "Saturday", "17:00")
    body = second.get("response_json") or {}
    text = str(body.get("message") or "")
    says_full = "weekly schedule has no free standing slot" in text
    suggests = any(
        phrase in text.lower()
        for phrase in ("choose", "pick ", "select a", "you may request", "try ")
    ) or body.get("suggestChoosing") is True
    refused = is_refused(second) and says_full and not suggests
    after = schedule_of(app)
    holds_after = holds_for(after, "12")
    listed, _, _ = views(app)
    list_body = listed.get("response_json") or {}
    listed_for_12 = [
        slot for slot in list_body.get("slots") or [] if str(slot.get("apartment")) == "12"
    ]
    still_one = len(holds_after) == 1 and len(listed_for_12) == 1
    original = any(
        h["dressingRoom"] == "pukuhuone 8" and h["weekday"] == "Tuesday" and h["startTime"] == "17:00"
        for h in holds_after
    )
    passed = given_one and given_full and refused and still_one and original
    steps = [
        step(
            "Given the household in apartment 12 holds one standing slot",
            "passed" if given_one else "failed",
            f"Re-read before the second request, apartment 12 holds={holds_mid}.",
        ),
        step(
            "And no free standing slots remain in the weekly schedule",
            "passed" if given_full else "failed",
            f"Free slots={free}; filler confirmations={filler_ok}.",
        ),
        step(
            "When the household in apartment 12 requests a second standing slot",
            "passed" if second["status"] else "failed",
            f"POST Saturday 17:00 pukuhuone 9 -> {second['status']} {second['response_text']}",
        ),
        step(
            "Then the refusal says the weekly schedule has no free standing slot and does not suggest choosing one",
            "passed" if refused else "failed",
            f"message={text!r} suggestChoosing={body.get('suggestChoosing')!r} suggests_choice={suggests}.",
        ),
        step(
            "And the household in apartment 12 still holds exactly one standing slot",
            "passed" if still_one and original else "failed",
            f"Re-read schedule holds={holds_after}; posted list for 12={listed_for_12}.",
        ),
    ]
    message = (
        "Request: POST /api/standing-slot/request apartment 12 Saturday 17:00 pukuhuone 9 while every standing slot was held. "
        f"Observed {second['status']} {second['response_text']}. "
        f"Re-read apartment 12 holds={holds_after}. "
        f"Consequence: full-schedule refusal without a choice suggestion={refused}; still exactly one hold={still_one and original}."
    )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps(
            {
                "fillers": fillers,
                "free_before_second": free,
                "holds_before": holds_mid,
                "second_status": second["status"],
                "second_response": body,
                "holds_after": holds_after,
                "posted_list_for_12": listed_for_12,
            },
            indent=2,
        ),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def derived_snapshot(app):
    schedule = schedule_of(app)
    listed, heater, billing = views(app)
    return {
        "schedule_status": 200,
        "tuesday_hold": [
            h
            for h in holders(schedule)
            if h["dressingRoom"] == "pukuhuone 8"
            and h["weekday"] == "Tuesday"
            and h["startTime"] == "17:00"
        ],
        "slot_list": listed.get("response_json"),
        "heater": heater.get("response_json"),
        "billing": billing.get("response_json"),
        "slot_list_status": listed["status"],
        "heater_status": heater["status"],
        "billing_status": billing["status"],
    }


def grade_007(app):
    before = schedule_of(app)
    _, day = slot_of(before, "pukuhuone 8", "Tuesday")
    slots = day.get("slots") or []
    free = any(
        slot.get("startTime") == "17:00" and slot.get("heldBy") in (None, "") and slot.get("bookable") is True
        for slot in slots
    )
    response = request_slot(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    confirmed = is_confirmed(response)
    snap = derived_snapshot(app)
    list_hits = [
        slot
        for slot in (snap["slot_list"] or {}).get("slots") or []
        if str(slot.get("apartment")) == "12"
        and slot.get("dressingRoom") == "pukuhuone 8"
        and slot.get("weekday") == "Tuesday"
        and str(slot.get("time")) == "17:00-18:30"
    ]
    heat_hits = [
        row
        for row in (snap["heater"] or {}).get("schedule") or []
        if row.get("dressingRoom") == "pukuhuone 8"
        and row.get("weekday") == "Tuesday"
        and row.get("heatFrom") == "17:00"
        and row.get("heatTo") == "18:30"
    ]
    charges = [
        row
        for row in (snap["billing"] or {}).get("activeCharges") or []
        if str(row.get("payer")) == "12"
        and row.get("basis") == "standing_slot"
        and row.get("dressingRoom") == "pukuhuone 8"
        and row.get("weekday") == "Tuesday"
        and row.get("startTime") == "17:00"
    ]
    ledger = [
        row
        for row in (snap["billing"] or {}).get("ledger") or []
        if str(row.get("apartment")) == "12"
        and row.get("dressingRoom") == "pukuhuone 8"
        and row.get("weekday") == "Tuesday"
        and row.get("startTime") == "17:00"
        and row.get("action") == "raised"
    ]
    same_record = (
        len(snap["tuesday_hold"]) == 1
        and str(snap["tuesday_hold"][0]["heldBy"]) == "12"
        and len(list_hits) == 1
        and len(heat_hits) == 1
        and len(charges) == 1
        and len(ledger) == 1
    )
    passed = free and confirmed and same_record
    steps = [
        step(
            "Given Tuesday at 17:00 in pukuhuone 8 is free",
            "passed" if free else "failed",
            f"Tuesday slots before confirmation={slots}.",
        ),
        step(
            "When the household in apartment 12's standing slot request for Tuesday at 17:00 in pukuhuone 8 is confirmed",
            "passed" if confirmed else "failed",
            f"POST -> {response['status']} {response['response_text']}",
        ),
        step(
            "Then the posted slot list shows the slot for apartment 12",
            "passed" if len(list_hits) == 1 else "failed",
            f"GET /api/views/slot-list status={snap['slot_list_status']} matches={list_hits}.",
        ),
        step(
            "And the heater schedule heats pukuhuone 8's sauna for Tuesday 17:00 to 18:30",
            "passed" if len(heat_hits) == 1 else "failed",
            f"GET /api/views/heater status={snap['heater_status']} matches={heat_hits}.",
        ),
        step(
            "And an invoicing signal is raised naming apartment 12 as payer for the standing slot",
            "passed" if len(charges) == 1 and len(ledger) == 1 else "failed",
            f"activeCharges={charges}; raised ledger={ledger}.",
        ),
    ]
    message = (
        "Request: POST /api/standing-slot/request apartment 12 Tuesday 17:00 pukuhuone 8, then re-read the three views. "
        f"Observed confirmation {response['status']} {response['response_text']}. "
        f"Posted list={list_hits}; heater={heat_hits}; billing charge={charges} ledger={ledger}; schedule hold={snap['tuesday_hold']}. "
        f"Consequence: all three views match that same booking record={same_record}."
    )
    surprises = []
    if confirmed and not same_record:
        surprises.append(
            {
                "observation": "After confirmation the posted list, heater schedule, billing signal, and schedule hold did not all describe the same booking.",
                "evidence_file": "items/01-007/transcript.json",
            }
        )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": surprises,
        "attachment_text": json.dumps({"confirmation": response.get("response_json"), "views": snap}, indent=2),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_008(app):
    setup = request_slot(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    before = derived_snapshot(app)
    given = is_confirmed(setup) and any(str(h["heldBy"]) == "12" for h in before["tuesday_hold"])
    release = give_up(app, "12", "pukuhuone 8", "Tuesday", "17:00")
    after = derived_snapshot(app)
    list_hits = [
        slot
        for slot in (after["slot_list"] or {}).get("slots") or []
        if slot.get("dressingRoom") == "pukuhuone 8"
        and slot.get("weekday") == "Tuesday"
        and str(slot.get("time", "")).startswith("17:00")
    ]
    heat_hits = [
        row
        for row in (after["heater"] or {}).get("schedule") or []
        if row.get("weekday") == "Tuesday" and row.get("heatFrom") == "17:00"
    ]
    active = [
        row
        for row in (after["billing"] or {}).get("activeCharges") or []
        if str(row.get("payer")) == "12"
    ]
    ledger = [
        row
        for row in (after["billing"] or {}).get("ledger") or []
        if str(row.get("apartment")) == "12"
        and row.get("dressingRoom") == "pukuhuone 8"
        and row.get("weekday") == "Tuesday"
        and row.get("startTime") == "17:00"
    ]
    raised = sum(1 for row in ledger if row.get("action") == "raised")
    stopped = sum(1 for row in ledger if row.get("action") == "stopped")
    no_further = active == [] and raised >= 1 and stopped >= raised
    list_clear = list_hits == []
    heat_clear = heat_hits == []
    schedule_clear = before["tuesday_hold"] != [] and after["tuesday_hold"] == []
    agree = list_clear and heat_clear and no_further and schedule_clear
    passed = given and release.get("response_json", {}).get("ok") is True and agree
    steps = [
        step(
            "Given the household in apartment 12 holds the Tuesday 17:00 standing slot in pukuhuone 8",
            "passed" if given else "failed",
            f"Re-read before release, schedule hold={before['tuesday_hold']}.",
        ),
        step(
            "When the household in apartment 12 gives up the standing slot",
            "passed" if release["status"] else "failed",
            f"POST /api/standing-slot/give-up -> {release['status']} {release['response_text']}",
        ),
        step(
            "Then the posted slot list no longer shows the slot",
            "passed" if list_clear else "failed",
            f"slot-list Tuesday 17:00 pukuhuone 8 entries={list_hits}.",
        ),
        step(
            "And the heater schedule no longer heats for Tuesday 17:00",
            "passed" if heat_clear else "failed",
            f"heater Tuesday 17:00 entries={heat_hits}.",
        ),
        step(
            "And no further standing-slot charge is raised for apartment 12",
            "passed" if no_further else "failed",
            f"activeCharges for 12={active}; ledger raised={raised} stopped={stopped} entries={ledger}.",
        ),
        step(
            "And no derived view disagrees with any other about the slot",
            "passed" if agree else "failed",
            f"schedule hold after={after['tuesday_hold']}; list clear={list_clear}; heat clear={heat_clear}; no further charge={no_further}.",
        ),
    ]
    message = (
        "Request: POST /api/standing-slot/give-up apartment 12 Tuesday 17:00 pukuhuone 8. "
        f"Observed {release['status']} {release['response_text']}. "
        f"Afterward schedule hold={after['tuesday_hold']}, slot-list={list_hits}, heater={heat_hits}, activeCharges={active}, ledger={ledger}. "
        f"Consequence: no view still claims the slot={agree}."
    )
    return {
        "status": "passed" if passed else "failed",
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps(
            {"before": before, "give_up": release.get("response_json"), "after": after},
            indent=2,
        ),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_009(app):
    before = schedule_of(app)
    _, day = slot_of(before, "pukuhuone 8", "Tuesday")
    slots = day.get("slots") or []
    free = any(
        slot.get("startTime") == "17:00" and slot.get("heldBy") in (None, "") and slot.get("bookable") is True
        for slot in slots
    )
    holds_12 = holds_for(before, "12")
    holds_3 = holds_for(before, "3")
    given = free and holds_12 == [] and holds_3 == []
    a, b, overlap = race_once(app)
    observed = observe_race_outcome(app, a, b, overlap)
    classification = observed["classification"]
    clean = (
        overlap
        and classification["clean_exactly_one"]
        and observed["views_agree_on_one_holder"]
        and not observed["two_holders_in_a_view"]
    )
    passed = given and clean
    both_text = json.dumps(
        {
            "12": {"status": a.get("status"), "body": a.get("response_json"), "error": a.get("error")},
            "3": {"status": b.get("status"), "body": b.get("response_json"), "error": b.get("error")},
        }
    )
    steps = [
        step(
            "Given Tuesday at 17:00 in pukuhuone 8 is free",
            "passed" if free else "failed",
            f"Tuesday slots={slots}.",
        ),
        step(
            "And neither the household in apartment 12 nor the household in apartment 3 holds it",
            "passed" if holds_12 == [] and holds_3 == [] else "failed",
            f"holds 12={holds_12} holds 3={holds_3}.",
        ),
        step(
            "When both households request a standing slot on Tuesday at 17:00 in pukuhuone 8",
            "passed" if a.get("status") and b.get("status") else "failed",
            f"Concurrent POST responses: {both_text}",
        ),
        step(
            "And the second request is made before the first has been answered",
            "passed" if overlap else "failed",
            f"Both request bodies were sent before either response was read. overlap={overlap} timings 12=({a.get('t_sent')},{a.get('t_read')}) 3=({b.get('t_sent')},{b.get('t_read')}).",
        ),
        step(
            "Then exactly one of the two requests is confirmed",
            "passed" if classification["bucket"] == "one_confirmed" else "failed",
            f"classification={classification}.",
        ),
        step(
            "And the other is refused because the slot is held",
            "passed" if classification.get("loser_refused_because_held") is True else "failed",
            f"loser_refused_because_held={classification.get('loser_refused_because_held')}.",
        ),
        step(
            "And exactly one household holds the Tuesday 17:00 standing slot in pukuhuone 8",
            "passed" if len(observed["schedule_holds"]) == 1 else "failed",
            f"schedule holds={observed['schedule_holds']}.",
        ),
        step(
            "And no derived view shows two holders for it",
            "passed" if not observed["two_holders_in_a_view"] and observed["views_agree_on_one_holder"] else "failed",
            f"list={observed['list_hits']} heater={observed['heat_hits']} billing={observed['charge_hits']}.",
        ),
    ]
    if not (a.get("status") and b.get("status")):
        message = (
            "not reached: the in-flight pair did not both return an HTTP response. "
            f"12={a.get('error') or a.get('status')} 3={b.get('error') or b.get('status')}."
        )
        status = "failed"
    else:
        status = "passed" if passed else "failed"
        message = (
            "Request: concurrent POST /api/standing-slot/request from apartments 12 and 3 for Tuesday 17:00 pukuhuone 8, "
            "with both requests sent before either response was read. "
            f"Observed {both_text}. Schedule holds={observed['schedule_holds']}. "
            f"Derived views list={observed['list_hits']} heater={observed['heat_hits']} billing={observed['charge_hits']}. "
            f"Consequence: exactly one holder and the other refused because held={clean}."
        )
    return {
        "status": status,
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps({"responses": {"12": a, "3": b}, "outcome": observed}, indent=2, default=str),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_010(app):
    counts = {"one_confirmed": 0, "both_confirmed": 0, "neither_confirmed": 0, "other": 0}
    runs = []
    violations = []
    transport_retries = 0
    restarts = 0
    target = 100
    attempt = 0
    while len(runs) < target and attempt < target + 30:
        attempt += 1
        free, _schedule = release_tuesday(app)
        if not free:
            restarts += 1
            app.stop()
            app.start()
            free, _schedule = release_tuesday(app)
            if not free:
                violations.append({"run": len(runs) + 1, "problem": "slot could not be made free"})
                break
        a, b, overlap = race_once(app)
        if a.get("error") or b.get("error") or not overlap:
            transport_retries += 1
            release_tuesday(app)
            if transport_retries > 15:
                violations.append({"problem": "too many transport failures", "last": {"12": a.get("error"), "3": b.get("error")}})
                break
            continue
        observed = observe_race_outcome(app, a, b, overlap)
        bucket = observed["classification"]["bucket"]
        if bucket not in counts:
            bucket = "other"
        counts[bucket] += 1
        clean = observed["classification"]["clean_exactly_one"] and observed["views_agree_on_one_holder"] and not observed["two_holders_in_a_view"]
        record = {
            "run": len(runs) + 1,
            "bucket": bucket,
            "winner": observed["classification"].get("winner"),
            "clean_exactly_one": clean,
            "loser_refused_because_held": observed["classification"].get("loser_refused_because_held"),
            "two_holders_in_a_view": observed["two_holders_in_a_view"],
            "schedule_holder": [h.get("heldBy") for h in observed["schedule_holds"]],
            "responses": {
                "12": {"status": a.get("status"), "body": a.get("response_json")},
                "3": {"status": b.get("status"), "body": b.get("response_json")},
            },
        }
        runs.append(record)
        if not clean:
            violations.append(record)
        release_tuesday(app)
    summary = {
        "runs": len(runs),
        "one_confirmed": counts["one_confirmed"],
        "both_confirmed": counts["both_confirmed"],
        "neither_confirmed": counts["neither_confirmed"],
        "other": counts["other"],
        "violations": len(violations),
        "transport_retries_not_counted": transport_retries,
        "restarts": restarts,
    }
    (app.item_dir / "race-counts.json").write_text(
        json.dumps({"summary": summary, "runs": runs, "violations": violations}, indent=2),
        encoding="utf-8",
    )
    complete = len(runs) == 100
    passed = (
        complete
        and counts["one_confirmed"] == 100
        and counts["both_confirmed"] == 0
        and counts["neither_confirmed"] == 0
        and counts["other"] == 0
        and violations == []
    )
    if not complete:
        status_name = "failed"
        message = (
            "not reached: could not complete 100 races from a free slot. "
            f"Completed {len(runs)}. Counts one={counts['one_confirmed']} both={counts['both_confirmed']} neither={counts['neither_confirmed']}."
        )
    else:
        status_name = "passed" if passed else "failed"
        message = (
            "Request: 100 in-flight races, apartments 12 and 3, POST /api/standing-slot/request Tuesday 17:00 pukuhuone 8, "
            "slot freed and re-read before every run, both requests sent before either response was read. "
            f"Observed one_confirmed={counts['one_confirmed']}, both_confirmed={counts['both_confirmed']}, neither_confirmed={counts['neither_confirmed']}. "
            f"Violations={len(violations)}. Consequence: every run confirmed exactly one household={passed}."
        )
    steps = [
        step(
            "Given the slot is free again at the start of every run",
            "passed" if complete else "failed",
            f"Each counted run released and re-read the Tuesday 17:00 pukuhuone 8 slot first. restarts={restarts}.",
        ),
        step(
            "When the two household race above is run 100 times",
            "passed" if complete else "failed",
            f"Counted runs={len(runs)}; uncounted transport retries={transport_retries}.",
        ),
        step(
            "Then all 100 runs confirm exactly one household",
            "passed" if counts["one_confirmed"] == 100 and violations == [] else "failed",
            f"one_confirmed={counts['one_confirmed']} violations={len(violations)}.",
        ),
        step(
            "And no run confirms both",
            "passed" if counts["both_confirmed"] == 0 and complete else "failed",
            f"both_confirmed={counts['both_confirmed']}.",
        ),
        step(
            "And no run refuses both",
            "passed" if counts["neither_confirmed"] == 0 and complete else "failed",
            f"neither_confirmed={counts['neither_confirmed']}.",
        ),
    ]
    return {
        "status": status_name,
        "message": message,
        "steps": steps,
        "surprises": [],
        "attachment_text": json.dumps({"summary": summary, "violations": violations}, indent=2),
        "attachment_ext": "json",
        "attachment_type": "application/json",
    }


def grade_011(app):
    before = schedule_of(app)
    ph9 = before["dressingRooms"]["pukuhuone 9"]["saunaDays"]
    response = request_slot(app, "12", "pukuhuone 9", "Tuesday", "17:00")
    body = response.get("response_json") or {}
    text = str(body.get("message") or "")
    given_ok = ph9 == ["Thursday", "Friday", "Saturday"] and is_refused(response) and text
    blind_path = WORK / "blind-review-011.txt"
    blind_path.write_text(text, encoding="utf-8")
    steps = [
        step(
            "Given the household in apartment 12 has been refused a standing slot on Tuesday at 17:00 in pukuhuone 9",
            "passed" if given_ok else "failed",
            f"POST status={response['status']} reason={body.get('reason')} refusal collected separately for blind review.",
        ),
        {
            "name": "When a fresh independent subagent with no prior context or configuration reads only the refusal",
            "status": "skipped",
            "stage": "pending",
            "statusDetails": {
                "message": "not reached: blind subagent review required. This grader has read the spec and cannot be that subagent."
            },
        },
        {
            "name": "Then it can name a dressing room, weekday and start time for a standing-slot request that the app confirms from fresh state, using nothing but the refusal",
            "status": "skipped",
            "stage": "pending",
            "statusDetails": {
                "message": "not reached: blind subagent review required. The suggested request was not judged or replayed here."
            },
        },
        {
            "name": "And a refusal it cannot act on fails this budget, and its wording is changed before the slice is called done",
            "status": "skipped",
            "stage": "pending",
            "statusDetails": {
                "message": "not reached: blind subagent review required."
            },
        },
    ]
    return {
        "status": "skipped",
        "stage": "pending",
        "message": (
            "not reached: blind subagent review required. "
            "Request: POST /api/standing-slot/request apartment 12 Tuesday 17:00 pukuhuone 9. "
            f"Observed status {response['status']}. The exact refusal text was written to work/blind-review-011.txt with no configuration and no grader answer. "
            "Consequence: usability was not judged."
        ),
        "steps": steps,
        "surprises": [],
        "attachment_text": text,
        "attachment_ext": "txt",
        "attachment_type": "text/plain",
        "blind_text": text,
    }


ITEMS_SPEC = [
    ("01-001", 19101, grade_001),
    ("01-002", 19102, grade_002),
    ("01-003", 19103, grade_003),
    ("01-004", 19104, grade_004),
    ("01-005", 19105, grade_005),
    ("01-006", 19106, grade_006),
    ("01-007", 19107, grade_007),
    ("01-008", 19108, grade_008),
    ("01-009", 19109, grade_009),
    ("01-010", 19110, grade_010),
    ("01-011", 19111, grade_011),
]

CHECKLIST = {
    "01-001": {
        "name": "The weekly schedule shows each dressing room's own sauna days",
        "rule": "Availability is per dressing room, per weekday",
        "technique": "acceptance",
    },
    "01-002": {
        "name": "A standing slot cannot be requested on a closed day",
        "rule": "Availability is per dressing room, per weekday",
        "technique": "acceptance",
    },
    "01-003": {
        "name": "A requested slot on an open day is confirmed",
        "rule": "A slot is confirmed against availability and held by one household",
        "technique": "acceptance",
    },
    "01-004": {
        "name": "A held slot cannot be confirmed for another household",
        "rule": "A slot is confirmed against availability and held by one household",
        "technique": "acceptance",
    },
    "01-005": {
        "name": "A second standing slot is granted while there is room",
        "rule": "A household may hold a second standing slot when there is room",
        "technique": "acceptance",
    },
    "01-006": {
        "name": "A second standing slot is refused when the schedule is full",
        "rule": "A household may hold a second standing slot when there is room",
        "technique": "acceptance",
    },
    "01-007": {
        "name": "Confirming a booking updates all three derived views together",
        "rule": "One booking is the single source of truth for the list, the timer and the billing",
        "technique": "acceptance",
    },
    "01-008": {
        "name": "Giving up a slot leaves no derived view still claiming it",
        "rule": "One booking is the single source of truth for the list, the timer and the billing",
        "technique": "acceptance",
    },
    "01-009": {
        "name": "Two households request the same free slot with neither request answered",
        "rule": "Two households requesting one free slot leave exactly one holder",
        "technique": "acceptance",
    },
    "01-010": {
        "name": "The race is run one hundred times and never confirms twice",
        "rule": "Two households requesting one free slot leave exactly one holder",
        "technique": "acceptance",
    },
    "01-011": {
        "name": "The refusal for a closed day is judged usable",
        "rule": "A refusal is judged by whether a resident can act on it without asking again",
        "technique": "usability",
    },
}


def write_allure(item_id, graded):
    meta = CHECKLIST[item_id]
    result_uuid = str(uuid.uuid4())
    attachment_uuid = str(uuid.uuid4())
    ext = graded["attachment_ext"]
    source = f"{attachment_uuid}-attachment.{ext}"
    (RESULTS / source).write_text(graded["attachment_text"], encoding="utf-8")
    stage = graded.get("stage", "finished")
    for item_step in graded["steps"]:
        item_step.setdefault("stage", "finished")
        item_step["start"] = graded["start"]
        item_step["stop"] = graded["stop"]
    document = {
        "uuid": result_uuid,
        "historyId": f"loyly.booking-core.{item_id}",
        "testCaseId": f"loyly.booking-core.{item_id}",
        "fullName": f"loyly.booking-core.{item_id}",
        "name": meta["name"],
        "status": graded["status"],
        "stage": stage,
        "statusDetails": {"message": graded["message"]},
        "start": graded["start"],
        "stop": graded["stop"],
        "labels": [
            {"name": "lifecycle", "value": "pre-production"},
            {"name": "technique", "value": meta["technique"]},
            {"name": "tool", "value": "Cursor black-box grader"},
            {"name": "feature", "value": "Booking core"},
            {"name": "story", "value": meta["rule"]},
            {"name": "tag", "value": f"@item-{item_id}"},
        ],
        "steps": graded["steps"],
        "attachments": [
            {
                "name": f"{item_id} observation",
                "source": source,
                "type": graded["attachment_type"],
            }
        ],
    }
    path = RESULTS / f"{result_uuid}-result.json"
    path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    return path


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    ITEMS.mkdir(parents=True, exist_ok=True)
    kill_listeners()
    surprises = []
    written = []
    for item_id, port, fn in ITEMS_SPEC:
        print(f"START {item_id}", flush=True)
        graded = run_item(item_id, port, fn)
        for surprise in graded.get("surprises") or []:
            surprises.append({"item": item_id, **surprise})
        path = write_allure(item_id, graded)
        written.append((item_id, graded["status"], str(path)))
        print(f"DONE {item_id} {graded['status']}", flush=True)
    (WORK / "surprises.json").write_text(json.dumps(surprises, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"written": written, "surprises": len(surprises)}, indent=2))


if __name__ == "__main__":
    main()
