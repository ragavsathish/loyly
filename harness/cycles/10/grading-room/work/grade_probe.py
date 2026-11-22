#!/usr/bin/env python3
"""Black-box HTTP probes for booking-core checklist items.

Copies impl/ to a fresh runtime per item, starts start.sh, observes HTTP,
then stops and reaps the server. Does not read candidate source.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOM = Path("/tmp/loyly-cursor-cycle-10/grading-room")
IMPL = ROOM / "impl"
WORK = ROOM / "work"

ROOM8 = "pukuhuone 8"
ROOM9 = "pukuhuone 9"
TUE = "Tuesday"
THU = "Thursday"
FRI = "Friday"
SAT = "Saturday"
START = "17:00"
END = "18:30"


def now_ms() -> int:
    return int(time.time() * 1000)


def copy_runtime(item: str) -> Path:
    runtime = WORK / item / "runtime"
    if runtime.exists():
        shutil.rmtree(runtime)
    runtime.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(IMPL, runtime, symlinks=True)
    start = runtime / "start.sh"
    start.chmod(start.stat().st_mode | 0o755)
    return runtime


def pids_on_port(port: int) -> set[int]:
    hexport = f"{port:04X}"
    inodes = set()
    for name in ("/proc/net/tcp", "/proc/net/tcp6"):
        path = Path(name)
        if not path.exists():
            continue
        lines = path.read_text(errors="replace").splitlines()[1:]
        for line in lines:
            parts = line.split()
            if len(parts) < 10:
                continue
            local = parts[1]
            if local.rsplit(":", 1)[-1].upper() == hexport:
                inodes.add(parts[9])
    pids = set()
    if not inodes:
        return pids
    proc = Path("/proc")
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        fd_dir = entry / "fd"
        try:
            fds = list(fd_dir.iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith("socket:[") and target[8:-1] in inodes:
                pids.add(int(entry.name))
                break
    return pids


class App:
    def __init__(self, item: str, port: int):
        self.item = item
        self.port = port
        self.runtime = copy_runtime(item)
        self.log_path = WORK / item / "start.log"
        self.cmd_path = WORK / item / "command.log"
        self.proc: subprocess.Popen | None = None
        self.extra_pids: set[int] = set()
        self.cmd_lines: list[str] = []

    def log(self, line: str) -> None:
        self.cmd_lines.append(line)
        self.cmd_path.parent.mkdir(parents=True, exist_ok=True)
        with self.cmd_path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def start(self) -> None:
        self.log(f"$ cp -a {IMPL}/. {self.runtime}/")
        self.log(f"$ cd {self.runtime} && ./start.sh {self.port}")
        self.log_path.write_text("", encoding="utf-8")
        out = open(self.log_path, "ab", buffering=0)
        self.proc = subprocess.Popen(
            ["./start.sh", str(self.port)],
            cwd=self.runtime,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.log(f"start_pid={self.proc.pid}")
        deadline = time.time() + 15
        last = ""
        while time.time() < deadline:
            try:
                status, text, _ = request(self.port, "GET", "/api/health")
                last = f"{status} {text}"
                if status == 200 and "ok" in text:
                    self.log(f"GET /api/health -> {status} {text}")
                    self.extra_pids = pids_on_port(self.port)
                    self.log(f"listeners={sorted(self.extra_pids)}")
                    return
            except Exception as exc:  # noqa: BLE001
                last = str(exc)
            if self.proc.poll() is not None:
                break
            time.sleep(0.15)
        raise RuntimeError(f"app not ready on {self.port}: {last}; log={self.log_path.read_text(errors='replace')[:500]}")

    def stop(self) -> None:
        pids = set(pids_on_port(self.port))
        if self.proc is not None and self.proc.poll() is None:
            pids.add(self.proc.pid)
        pids |= self.extra_pids
        self.log(f"reap pids={sorted(pids)}")
        for pid in pids:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        deadline = time.time() + 3
        while time.time() < deadline:
            alive = []
            for pid in pids:
                try:
                    os.kill(pid, 0)
                    alive.append(pid)
                except OSError:
                    pass
            if not alive and not pids_on_port(self.port):
                break
            time.sleep(0.1)
        still = pids_on_port(self.port)
        for pid in list(still):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except OSError:
                    self.proc.kill()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self.log(f"stopped listeners={sorted(pids_on_port(self.port))} exit={None if self.proc is None else self.proc.poll()}")


def request(port: int, method: str, path: str, body: dict | None = None, timeout: float = 5.0):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    url = f"http://127.0.0.1:{port}{path}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            elapsed = round((time.perf_counter() - started) * 1000, 3)
            text = raw.decode()
            parsed = _parse(text)
            return resp.status, text, {
                "method": method,
                "path": path,
                "request": body,
                "status": resp.status,
                "bodyText": text,
                "body": parsed,
                "elapsedMs": elapsed,
            }
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        elapsed = round((time.perf_counter() - started) * 1000, 3)
        text = raw.decode(errors="replace")
        parsed = _parse(text)
        return exc.code, text, {
            "method": method,
            "path": path,
            "request": body,
            "status": exc.code,
            "bodyText": text,
            "body": parsed,
            "elapsedMs": elapsed,
        }


def _parse(text: str):
    try:
        return json.loads(text)
    except Exception:
        return None


def call(app: App, method: str, path: str, body: dict | None = None):
    shown = "" if body is None else " " + json.dumps(body, ensure_ascii=False)
    app.log(f"$ {method} {path}{shown}")
    status, text, rec = request(app.port, method, path, body)
    app.log(f"-> {status} {text}")
    return rec


def schedule(app: App):
    return call(app, "GET", "/api/schedule")


def posted(app: App):
    return call(app, "GET", "/api/views/posted-list")


def heater(app: App):
    return call(app, "GET", "/api/views/heater-schedule")


def invoicing(app: App):
    return call(app, "GET", "/api/views/invoicing-signals")


def book(app: App, apartment: int, room: str, weekday: str, start: str = START):
    return call(
        app,
        "POST",
        "/api/standing-slots/request",
        {
            "apartment": apartment,
            "dressingRoom": room,
            "weekday": weekday,
            "startTime": start,
        },
    )


def give_up(app: App, apartment: int, room: str = ROOM8, weekday: str = TUE, start: str = START):
    return call(
        app,
        "POST",
        "/api/standing-slots/give-up",
        {
            "apartment": apartment,
            "dressingRoom": room,
            "weekday": weekday,
            "startTime": start,
        },
    )


def slot_of(sched_body: dict, room: str, weekday: str):
    days = (sched_body or {}).get("dressingRooms", {}).get(room, {})
    slots = days.get(weekday)
    if not slots:
        return None
    for slot in slots:
        if slot.get("startTime") == START:
            return slot
    return slots[0]


def holders_for(sched_body: dict, room: str, weekday: str):
    slot = slot_of(sched_body, room, weekday)
    if not slot:
        return []
    holder = slot.get("holder")
    if holder is None:
        return []
    return [holder]


def is_confirm(rec: dict) -> bool:
    body = rec.get("body") or {}
    return rec.get("status") == 200 and body.get("ok") is True and isinstance(body.get("slot"), dict)


def write_obs(item: str, obs: dict) -> None:
    path = WORK / item / "observation.json"
    path.write_text(json.dumps(obs, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def base_obs(item: str, port: int, start_ms: int):
    return {
        "item": item,
        "port": port,
        "startMs": start_ms,
        "exchanges": [],
        "checks": [],
        "notes": [],
    }


def add_check(obs, name, ok, detail):
    obs["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    return bool(ok)


def race_once(port: int):
    """Send both household requests before reading either response."""
    path = "/api/standing-slots/request"
    bodies = {
        12: {
            "apartment": 12,
            "dressingRoom": ROOM8,
            "weekday": TUE,
            "startTime": START,
        },
        3: {
            "apartment": 3,
            "dressingRoom": ROOM8,
            "weekday": TUE,
            "startTime": START,
        },
    }
    go = threading.Barrier(2, timeout=5)
    sent = threading.Barrier(2, timeout=5)
    results = {}
    errors = {}

    def worker(apartment: int):
        payload = json.dumps(bodies[apartment]).encode()
        conn = None
        try:
            import http.client

            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.connect()
            t_go = time.perf_counter()
            go.wait()
            t_send = time.perf_counter()
            conn.request(
                "POST",
                path,
                body=payload,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Content-Length": str(len(payload)),
                    "Connection": "close",
                },
            )
            t_sent = time.perf_counter()
            sent.wait()
            t_read = time.perf_counter()
            resp = conn.getresponse()
            raw = resp.read()
            t_done = time.perf_counter()
            text = raw.decode(errors="replace")
            results[apartment] = {
                "method": "POST",
                "path": path,
                "request": bodies[apartment],
                "status": resp.status,
                "bodyText": text,
                "body": _parse(text),
                "timing": {
                    "go": t_go,
                    "sendStart": t_send,
                    "sendEnd": t_sent,
                    "readStart": t_read,
                    "done": t_done,
                },
            }
        except Exception as exc:  # noqa: BLE001
            errors[apartment] = f"{type(exc).__name__}: {exc}"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    threads = [threading.Thread(target=worker, args=(apt,)) for apt in (12, 3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=12)
    overlap = None
    if 12 in results and 3 in results:
        # Both sends finished before either read began.
        send_ends = [results[12]["timing"]["sendEnd"], results[3]["timing"]["sendEnd"]]
        read_starts = [results[12]["timing"]["readStart"], results[3]["timing"]["readStart"]]
        overlap = {
            "bothSendsFinishedBeforeEitherRead": max(send_ends) <= min(read_starts),
            "sendEnd": {"12": results[12]["timing"]["sendEnd"], "3": results[3]["timing"]["sendEnd"]},
            "readStart": {"12": results[12]["timing"]["readStart"], "3": results[3]["timing"]["readStart"]},
            "sendGapMs": round(abs(results[12]["timing"]["sendStart"] - results[3]["timing"]["sendStart"]) * 1000, 3),
        }
        # timings are absolute perf counters; store relative to earliest go
        origin = min(results[12]["timing"]["go"], results[3]["timing"]["go"])
        for apt in (12, 3):
            rel = {}
            for key, value in results[apt]["timing"].items():
                rel[key] = round((value - origin) * 1000, 3)
            results[apt]["timingMs"] = rel
            del results[apt]["timing"]
    return {"responses": results, "errors": errors, "overlap": overlap}


def classify_pair(responses: dict) -> str:
    confirms = []
    for apt in (12, 3):
        rec = responses.get(apt)
        if rec and is_confirm(rec):
            confirms.append(apt)
    if len(confirms) == 2:
        return "both-confirmed"
    if len(confirms) == 1:
        return "one-confirmed"
    return "neither-confirmed"


def ensure_slot_free(app: App, room=ROOM8, weekday=TUE):
    """Give up any observed holder so the slot reads free. Returns the free-check exchange."""
    sched = schedule(app)
    posted_rec = posted(app)
    body = sched.get("body") or {}
    slot = slot_of(body, room, weekday) or {}
    apartments = set()
    if slot.get("holder") is not None:
        apartments.add(slot.get("holder"))
    for entry in (posted_rec.get("body") or {}).get("slots") or []:
        if entry.get("dressingRoom") == room and entry.get("weekday") == weekday and entry.get("startTime") == START:
            if entry.get("apartment") is not None:
                apartments.add(entry.get("apartment"))
    if slot.get("status") != "free" or slot.get("holder") is not None or apartments:
        for apt in sorted(apartments, key=lambda x: str(x)):
            if isinstance(apt, int):
                give_up(app, apt, room, weekday, START)
        if not apartments:
            for apt in (12, 3):
                give_up(app, apt, room, weekday, START)
    return schedule(app)


def run_item(item: str, port: int, fn):
    app = App(item, port)
    start_ms = now_ms()
    obs = base_obs(item, port, start_ms)
    try:
        app.start()
        fn(app, obs)
    except Exception as exc:  # noqa: BLE001
        obs["error"] = f"{type(exc).__name__}: {exc}"
        obs["trace"] = traceback.format_exc()
        app.log(f"ERROR {obs['error']}")
    finally:
        try:
            app.stop()
        except Exception as exc:  # noqa: BLE001
            obs.setdefault("notes", []).append(f"stop error: {exc}")
        obs["stopMs"] = now_ms()
        write_obs(item, obs)
    return obs


def item_001(app: App, obs: dict):
    # Inspect each dressing room by reading its own day map from the weekly schedule.
    sched = schedule(app)
    obs["exchanges"].append(sched)
    body = sched.get("body") or {}
    rooms = body.get("dressingRooms") or {}
    room8 = rooms.get(ROOM8)
    room9 = rooms.get(ROOM9)
    obs["room8Days"] = room8
    obs["room9Days"] = room9
    tue8 = (room8 or {}).get(TUE)
    tue9 = (room9 or {}).get(TUE) if isinstance(room9, dict) else None
    bookable = []
    if isinstance(tue8, list):
        for slot in tue8:
            if slot.get("startTime") and slot.get("status") == "free":
                bookable.append(slot)
    add_check(
        obs,
        "Tuesday shows bookable slots for pukuhuone 8",
        bool(bookable),
        {"tuesdaySlots": tue8, "bookable": bookable},
    )
    no_room9_tuesday = (not isinstance(room9, dict)) or (TUE not in room9) or (room9.get(TUE) in ([], None))
    add_check(
        obs,
        "Tuesday shows no slots for pukuhuone 9",
        bool(room9) and no_room9_tuesday,
        {"tuesdayForRoom9": tue9, "room9Weekdays": list(room9.keys()) if isinstance(room9, dict) else None},
    )
    obs["saunaId"] = body.get("saunaId")


def item_002(app: App, obs: dict):
    sched = schedule(app)
    obs["exchanges"].append(sched)
    room9 = ((sched.get("body") or {}).get("dressingRooms") or {}).get(ROOM9) or {}
    obs["givenRoom9Days"] = list(room9.keys()) if isinstance(room9, dict) else room9
    rec = book(app, 12, ROOM9, TUE, START)
    obs["exchanges"].append(rec)
    body = rec.get("body") or {}
    message = body.get("message") if isinstance(body, dict) else None
    obs["refusal"] = rec.get("bodyText")
    obs["refusalMessage"] = message
    obs["openDays"] = body.get("openDays") if isinstance(body, dict) else None
    refused = rec.get("status") != 200 or body.get("ok") is False
    names_closed = isinstance(message, str) and ("pukuhuone 9" in message) and ("Tuesday" in message) and (
        "saunapäiv" in message or "no sauna" in message.lower() or "closed" in message.lower() or "ei ole" in message
    )
    named = []
    blob = rec.get("bodyText") or ""
    for day in ("Thursday", "Friday", "Saturday"):
        if day in blob:
            named.append(day)
    add_check(obs, "request refused because pukuhuone 9 has no sauna day on Tuesday", refused and names_closed, {
        "status": rec.get("status"),
        "reason": body.get("reason") if isinstance(body, dict) else None,
        "message": message,
    })
    add_check(obs, "refusal names the days pukuhuone 9 does open", named == ["Thursday", "Friday", "Saturday"], {
        "daysNamedInBody": named,
        "openDays": body.get("openDays") if isinstance(body, dict) else None,
        "message": message,
    })
    # consequence: no hold created for the closed day
    after = schedule(app)
    obs["exchanges"].append(after)
    tue = slot_of(after.get("body") or {}, ROOM9, TUE)
    add_check(obs, "Tuesday in pukuhuone 9 still has no held slot", tue is None, {"tuesdaySlot": tue})


def item_003(app: App, obs: dict):
    before = schedule(app)
    obs["exchanges"].append(before)
    slot = slot_of(before.get("body") or {}, ROOM8, TUE)
    add_check(obs, "Given Tuesday 17:00 in pukuhuone 8 is free", bool(slot) and slot.get("status") == "free" and slot.get("holder") is None, slot)
    rec = book(app, 12, ROOM8, TUE, START)
    obs["exchanges"].append(rec)
    body = rec.get("body") or {}
    slot_body = body.get("slot") if isinstance(body, dict) else None
    confirmed_window = (
        is_confirm(rec)
        and slot_body.get("startTime") == START
        and slot_body.get("endTime") == END
        and slot_body.get("apartment") == 12
        and slot_body.get("weekday") == TUE
        and slot_body.get("dressingRoom") == ROOM8
    )
    add_check(obs, "standing slot confirmed for 17:00 to 18:30", confirmed_window, {
        "status": rec.get("status"),
        "message": body.get("message") if isinstance(body, dict) else None,
        "slot": slot_body,
    })
    after = schedule(app)
    posted_rec = posted(app)
    obs["exchanges"].extend([after, posted_rec])
    held = slot_of(after.get("body") or {}, ROOM8, TUE)
    holds = bool(held) and held.get("status") == "held" and held.get("holder") == 12 and held.get("startTime") == START and held.get("endTime") == END
    posted_hits = [
        s for s in (posted_rec.get("body") or {}).get("slots") or []
        if s.get("apartment") == 12 and s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START
    ]
    message = (body.get("message") if isinstance(body, dict) else "") or ""
    every_tuesday = "every Tuesday" in message or (holds and held.get("weekday", TUE) == TUE and "Tuesday" in message)
    add_check(obs, "household 12 holds it for every coming Tuesday", holds and len(posted_hits) == 1 and ("every Tuesday" in message), {
        "scheduleSlot": held,
        "posted": posted_hits,
        "message": message,
        "weeklyTemplate": True if holds else False,
    })


def item_004(app: App, obs: dict):
    first = book(app, 12, ROOM8, TUE, START)
    given = schedule(app)
    obs["exchanges"].extend([first, given])
    held = slot_of(given.get("body") or {}, ROOM8, TUE)
    add_check(obs, "Given apartment 12 holds Tuesday 17:00 in pukuhuone 8", bool(held) and held.get("holder") == 12 and held.get("status") == "held", held)
    rec = book(app, 3, ROOM8, TUE, START)
    obs["exchanges"].append(rec)
    body = rec.get("body") or {}
    message = body.get("message") if isinstance(body, dict) else ""
    refused_held = (not is_confirm(rec)) and (
        (isinstance(body, dict) and body.get("reason") == "slot_held")
        or (isinstance(message, str) and "held" in message.lower())
    )
    add_check(obs, "request refused because the slot is held", refused_held, {
        "status": rec.get("status"),
        "reason": body.get("reason") if isinstance(body, dict) else None,
        "message": message,
    })
    after = schedule(app)
    posted_rec = posted(app)
    obs["exchanges"].extend([after, posted_rec])
    held_after = slot_of(after.get("body") or {}, ROOM8, TUE)
    posted_12 = [
        s for s in (posted_rec.get("body") or {}).get("slots") or []
        if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START and s.get("apartment") == 12
    ]
    posted_3 = [
        s for s in (posted_rec.get("body") or {}).get("slots") or []
        if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START and s.get("apartment") == 3
    ]
    add_check(obs, "apartment 12 still holds the slot", bool(held_after) and held_after.get("holder") == 12 and len(posted_12) == 1 and len(posted_3) == 0, {
        "scheduleSlot": held_after,
        "postedFor12": posted_12,
        "postedFor3": posted_3,
    })


def count_household(sched_body, posted_body, apartment: int):
    holds = []
    rooms = (sched_body or {}).get("dressingRooms") or {}
    for room, days in rooms.items():
        if not isinstance(days, dict):
            continue
        for weekday, slots in days.items():
            for slot in slots or []:
                if slot.get("holder") == apartment:
                    holds.append({"dressingRoom": room, "weekday": weekday, **slot})
    posted_hits = [
        s for s in (posted_body or {}).get("slots") or []
        if s.get("apartment") == apartment
    ]
    return holds, posted_hits


def free_count(sched_body):
    free = []
    rooms = (sched_body or {}).get("dressingRooms") or {}
    for room, days in rooms.items():
        if not isinstance(days, dict):
            continue
        for weekday, slots in days.items():
            for slot in slots or []:
                if slot.get("status") == "free" and slot.get("holder") is None:
                    free.append({"dressingRoom": room, "weekday": weekday, "startTime": slot.get("startTime"), "endTime": slot.get("endTime")})
    return free


def item_005(app: App, obs: dict):
    first = book(app, 12, ROOM8, TUE, START)
    given = schedule(app)
    obs["exchanges"].extend([first, given])
    holds, _ = count_household(given.get("body") or {}, {}, 12)
    free = free_count(given.get("body") or {})
    add_check(obs, "Given apartment 12 holds one standing slot and free slots remain", len(holds) == 1 and len(free) > 0, {
        "holds": holds,
        "free": free,
    })
    second = book(app, 12, ROOM9, THU, START)
    obs["exchanges"].append(second)
    body = second.get("body") or {}
    slot_body = body.get("slot") if isinstance(body, dict) else None
    confirmed = is_confirm(second) and slot_body and slot_body.get("apartment") == 12 and slot_body.get("dressingRoom") == ROOM9 and slot_body.get("weekday") == THU and slot_body.get("startTime") == START
    add_check(obs, "second standing slot is confirmed", confirmed, {
        "status": second.get("status"),
        "message": body.get("message") if isinstance(body, dict) else None,
        "slot": slot_body,
    })
    after = schedule(app)
    posted_rec = posted(app)
    obs["exchanges"].extend([after, posted_rec])
    holds_after, posted_hits = count_household(after.get("body") or {}, posted_rec.get("body") or {}, 12)
    distinct = {(h["dressingRoom"], h["weekday"], h.get("startTime")) for h in holds_after}
    posted_distinct = {(s.get("dressingRoom"), s.get("weekday"), s.get("startTime")) for s in posted_hits}
    add_check(obs, "apartment 12 holds two persisted standing slots", len(distinct) == 2 and distinct == {(ROOM8, TUE, START), (ROOM9, THU, START)} and posted_distinct == distinct, {
        "scheduleHolds": holds_after,
        "posted": posted_hits,
    })


def item_006(app: App, obs: dict):
    setup = [
        book(app, 12, ROOM8, TUE, START),
        book(app, 3, ROOM9, THU, START),
        book(app, 5, ROOM9, FRI, START),
        book(app, 7, ROOM9, SAT, START),
    ]
    given = schedule(app)
    posted_rec = posted(app)
    obs["exchanges"].extend(setup + [given, posted_rec])
    holds, posted_hits = count_household(given.get("body") or {}, posted_rec.get("body") or {}, 12)
    free = free_count(given.get("body") or {})
    add_check(obs, "Given apartment 12 holds one and no free standing slots remain", len(holds) == 1 and len(posted_hits) == 1 and len(free) == 0, {
        "holds": holds,
        "posted": posted_hits,
        "free": free,
    })
    rec = book(app, 12, ROOM9, FRI, START)
    obs["exchanges"].append(rec)
    body = rec.get("body") or {}
    message = body.get("message") if isinstance(body, dict) else ""
    message_l = message.lower() if isinstance(message, str) else ""
    says_none = isinstance(message, str) and ("no free standing slot" in message_l)
    suggests = False
    if isinstance(body, dict) and body.get("alternative"):
        suggests = True
    for token in ("voit varata", "choose", "you can book", "available at", "klo "):
        if token in message_l:
            suggests = True
    # A weekday name in this particular refusal would be offering a day to choose.
    for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"):
        if day in message_l:
            suggests = True
    add_check(obs, "refusal says the weekly schedule has no free standing slot and does not suggest choosing one", (not is_confirm(rec)) and says_none and not suggests, {
        "status": rec.get("status"),
        "reason": body.get("reason") if isinstance(body, dict) else None,
        "message": message,
        "alternative": body.get("alternative") if isinstance(body, dict) else None,
        "suggestsChoosing": suggests,
    })
    after = schedule(app)
    posted_after = posted(app)
    obs["exchanges"].extend([after, posted_after])
    holds_after, posted_after_hits = count_household(after.get("body") or {}, posted_after.get("body") or {}, 12)
    still_one = {(h["dressingRoom"], h["weekday"], h.get("startTime")) for h in holds_after} == {(ROOM8, TUE, START)}
    posted_one = {(s.get("dressingRoom"), s.get("weekday"), s.get("startTime")) for s in posted_after_hits} == {(ROOM8, TUE, START)}
    add_check(obs, "apartment 12 still holds exactly one standing slot", still_one and posted_one, {
        "scheduleHolds": holds_after,
        "posted": posted_after_hits,
    })


def views_for_slot(posted_body, heater_body, invoice_body, room, weekday, start, apartment=None):
    posted_hits = [
        s for s in (posted_body or {}).get("slots") or []
        if s.get("dressingRoom") == room and s.get("weekday") == weekday and s.get("startTime") == start
        and (apartment is None or s.get("apartment") == apartment)
    ]
    heat_hits = [
        s for s in (heater_body or {}).get("entries") or []
        if s.get("dressingRoom") == room and s.get("weekday") == weekday and s.get("startTime") == start
    ]
    signals = []
    for s in (invoice_body or {}).get("signals") or []:
        if s.get("dressingRoom") == room and s.get("weekday") == weekday and s.get("startTime") == start:
            if apartment is None or s.get("apartment") == apartment:
                signals.append(s)
    return posted_hits, heat_hits, signals


def item_007(app: App, obs: dict):
    before = schedule(app)
    obs["exchanges"].append(before)
    slot = slot_of(before.get("body") or {}, ROOM8, TUE)
    add_check(obs, "Given Tuesday 17:00 in pukuhuone 8 is free", bool(slot) and slot.get("status") == "free" and slot.get("holder") is None, slot)
    rec = book(app, 12, ROOM8, TUE, START)
    obs["exchanges"].append(rec)
    confirmed = is_confirm(rec)
    add_check(obs, "When the standing slot request is confirmed", confirmed, rec.get("body"))
    sched = schedule(app)
    post = posted(app)
    heat = heater(app)
    inv = invoicing(app)
    obs["exchanges"].extend([sched, post, heat, inv])
    held = slot_of(sched.get("body") or {}, ROOM8, TUE)
    posted_hits, heat_hits, signals = views_for_slot(post.get("body"), heat.get("body"), inv.get("body"), ROOM8, TUE, START, 12)
    charges = [s for s in signals if s.get("type") == "standing_slot_charge"]
    list_ok = len(posted_hits) == 1 and posted_hits[0].get("apartment") == 12 and posted_hits[0].get("endTime") == END
    heat_ok = len(heat_hits) == 1 and heat_hits[0].get("heats") is True and heat_hits[0].get("endTime") == END
    bill_ok = len(charges) == 1 and charges[0].get("apartment") == 12 and charges[0].get("endTime") == END and charges[0].get("basis") == "standing_slot"
    record_ok = bool(held) and held.get("holder") == 12 and held.get("status") == "held" and held.get("endTime") == END
    same = record_ok and list_ok and heat_ok and bill_ok
    # no second holder or contradictory extra charge for this slot
    all_posted = [
        s for s in (post.get("body") or {}).get("slots") or []
        if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START
    ]
    all_signals = [
        s for s in (inv.get("body") or {}).get("signals") or []
        if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START
    ]
    add_check(obs, "posted list, heater, and invoicing all derive from apartment 12's Tuesday 17:00-18:30 booking", same and len(all_posted) == 1 and len(all_signals) == 1, {
        "scheduleSlot": held,
        "posted": all_posted,
        "heater": heat_hits,
        "signals": all_signals,
    })


def item_008(app: App, obs: dict):
    first = book(app, 12, ROOM8, TUE, START)
    given = schedule(app)
    before_views = [posted(app), heater(app), invoicing(app)]
    obs["exchanges"].extend([first, given, *before_views])
    held = slot_of(given.get("body") or {}, ROOM8, TUE)
    add_check(obs, "Given apartment 12 holds Tuesday 17:00 in pukuhuone 8", bool(held) and held.get("holder") == 12, {
        "scheduleSlot": held,
        "posted": before_views[0].get("body"),
        "heater": before_views[1].get("body"),
        "invoicing": before_views[2].get("body"),
    })
    rel = give_up(app, 12, ROOM8, TUE, START)
    obs["exchanges"].append(rel)
    add_check(obs, "When give-up is accepted", rel.get("status") == 200 and (rel.get("body") or {}).get("ok") is True, rel.get("body"))
    sched = schedule(app)
    post = posted(app)
    heat = heater(app)
    inv = invoicing(app)
    obs["exchanges"].extend([sched, post, heat, inv])
    slot = slot_of(sched.get("body") or {}, ROOM8, TUE)
    posted_hits, heat_hits, signals = views_for_slot(post.get("body"), heat.get("body"), inv.get("body"), ROOM8, TUE, START, None)
    list_clear = len(posted_hits) == 0 and (not slot or (slot.get("status") == "free" and slot.get("holder") is None))
    heats = [h for h in heat_hits if h.get("heats") is True]
    heat_clear = len(heats) == 0
    charges = [s for s in signals if s.get("type") == "standing_slot_charge" and s.get("apartment") == 12]
    cancellations = [s for s in signals if s.get("type") != "standing_slot_charge" and s.get("apartment") == 12]
    other = [s for s in signals if s not in charges and s not in cancellations]
    # Active charge still claims the slot. A cancellation records the release.
    no_further_charge = len(charges) == 0
    # Disagreement: charge vs empty list/heater, or charge vs cancellation, or heater vs list.
    disagree = (len(charges) > 0 and list_clear) or (len(charges) > 0 and heat_clear) or (len(charges) > 0 and len(cancellations) > 0) or ((not list_clear) and heat_clear) or (list_clear and len(heats) > 0)
    add_check(obs, "posted slot list no longer shows the slot", list_clear, {"scheduleSlot": slot, "posted": posted_hits})
    add_check(obs, "heater schedule no longer heats Tuesday 17:00", heat_clear, {"heater": heat_hits})
    add_check(obs, "no further standing-slot charge is raised for apartment 12", no_further_charge, {
        "charges": charges,
        "cancellations": cancellations,
        "otherSignals": other,
        "allSignals": (inv.get("body") or {}).get("signals"),
    })
    add_check(obs, "no derived view disagrees about the slot", list_clear and heat_clear and no_further_charge and not disagree, {
        "listClear": list_clear,
        "heatClear": heat_clear,
        "charges": len(charges),
        "cancellations": cancellations,
        "disagree": disagree,
    })


def derived_two_holders(posted_body, heater_body, invoice_body):
    posted_hits = [
        s for s in (posted_body or {}).get("slots") or []
        if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START
    ]
    apartments = [s.get("apartment") for s in posted_hits]
    charges = [
        s for s in (invoice_body or {}).get("signals") or []
        if s.get("type") == "standing_slot_charge" and s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START
    ]
    charge_apts = [s.get("apartment") for s in charges]
    heat_hits = [
        s for s in (heater_body or {}).get("entries") or []
        if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START and s.get("heats") is True
    ]
    return {
        "posted": posted_hits,
        "postedApartments": apartments,
        "charges": charges,
        "chargeApartments": charge_apts,
        "heater": heat_hits,
        "twoPosted": len(set(apartments)) > 1 or apartments.count(12) + apartments.count(3) > 1 and len(apartments) > 1,
        "twoCharges": len(set(charge_apts)) > 1,
    }


def item_009(app: App, obs: dict):
    before = schedule(app)
    obs["exchanges"].append(before)
    slot = slot_of(before.get("body") or {}, ROOM8, TUE)
    free = bool(slot) and slot.get("status") == "free" and slot.get("holder") is None
    add_check(obs, "Given Tuesday 17:00 in pukuhuone 8 is free and neither household holds it", free, slot)
    app.log("$ concurrent POST /api/standing-slots/request apartment 12 and apartment 3 before either response is read")
    race = race_once(app.port)
    obs["race"] = race
    for apt in (12, 3):
        rec = (race.get("responses") or {}).get(apt)
        if rec:
            app.log(f"-> apartment {apt} {rec.get('status')} {rec.get('bodyText')}")
        else:
            app.log(f"-> apartment {apt} ERROR {race.get('errors')}")
    overlap_ok = bool(race.get("overlap") and race["overlap"].get("bothSendsFinishedBeforeEitherRead") and not race.get("errors"))
    add_check(obs, "second request was sent before the first response was read", overlap_ok, race.get("overlap") or race.get("errors"))
    responses = race.get("responses") or {}
    kind = classify_pair(responses)
    obs["responseClass"] = kind
    loser = None
    winner = None
    for apt in (12, 3):
        rec = responses.get(apt)
        if rec and is_confirm(rec):
            winner = apt
        elif rec:
            loser = apt
    loser_body = (responses.get(loser) or {}).get("body") if loser else None
    loser_msg = (loser_body or {}).get("message") if isinstance(loser_body, dict) else None
    refused_held = (
        loser is not None
        and not is_confirm(responses.get(loser) or {})
        and isinstance(loser_body, dict)
        and (loser_body.get("reason") == "slot_held" or (isinstance(loser_msg, str) and "held" in loser_msg.lower()))
    )
    sched = schedule(app)
    post = posted(app)
    heat = heater(app)
    inv = invoicing(app)
    obs["exchanges"].extend([sched, post, heat, inv])
    holders = holders_for(sched.get("body") or {}, ROOM8, TUE)
    derived = derived_two_holders(post.get("body"), heat.get("body"), inv.get("body"))
    obs["derived"] = derived
    exactly_one_response = kind == "one-confirmed"
    exactly_one_holder = len(holders) == 1 and holders[0] in (12, 3)
    no_two = (not derived["twoPosted"]) and (not derived["twoCharges"]) and len(derived["postedApartments"]) == 1 and len(set(derived["chargeApartments"])) <= 1
    add_check(obs, "exactly one of the two requests is confirmed", exactly_one_response and overlap_ok, {
        "class": kind,
        "winner": winner,
        "responses": {str(k): {"status": v.get("status"), "body": v.get("body")} for k, v in responses.items()},
    })
    add_check(obs, "the other is refused because the slot is held", refused_held and overlap_ok, {
        "loser": loser,
        "body": loser_body,
    })
    add_check(obs, "exactly one household holds the slot", exactly_one_holder and (winner is None or holders == [winner]), {
        "holders": holders,
        "winner": winner,
        "scheduleSlot": slot_of(sched.get("body") or {}, ROOM8, TUE),
    })
    add_check(obs, "no derived view shows two holders", no_two and exactly_one_holder, derived)


def item_010(app: App, obs: dict):
    runs = []
    counts = {"one-confirmed": 0, "both-confirmed": 0, "neither-confirmed": 0}
    violations = []
    for n in range(1, 101):
        free_rec = ensure_slot_free(app)
        slot = slot_of(free_rec.get("body") or {}, ROOM8, TUE)
        free_ok = bool(slot) and slot.get("status") == "free" and slot.get("holder") is None
        if not free_ok:
            runs.append({"n": n, "class": "precondition-failed", "slot": slot})
            violations.append({"n": n, "problem": "slot not free at start", "slot": slot})
            counts["neither-confirmed"] += 1
            continue
        race = race_once(app.port)
        responses = race.get("responses") or {}
        kind = classify_pair(responses)
        if race.get("errors") or not (race.get("overlap") or {}).get("bothSendsFinishedBeforeEitherRead"):
            kind_note = "in-flight-not-established"
        else:
            kind_note = "in-flight"
        sched = schedule(app)
        holders = holders_for(sched.get("body") or {}, ROOM8, TUE)
        post = posted(app)
        posted_apts = [
            s.get("apartment")
            for s in (post.get("body") or {}).get("slots") or []
            if s.get("dressingRoom") == ROOM8 and s.get("weekday") == TUE and s.get("startTime") == START
        ]
        state_one = len(holders) == 1 and len(posted_apts) == 1 and holders[0] == posted_apts[0]
        if kind != "one-confirmed" or not state_one or kind_note != "in-flight":
            violations.append({
                "n": n,
                "class": kind,
                "inFlight": kind_note,
                "holders": holders,
                "postedApartments": posted_apts,
                "errors": race.get("errors"),
                "overlap": race.get("overlap"),
                "responses": {
                    str(apt): {
                        "status": (responses.get(apt) or {}).get("status"),
                        "body": (responses.get(apt) or {}).get("body"),
                    }
                    for apt in (12, 3)
                },
            })
        if kind in counts:
            counts[kind] += 1
        else:
            counts["neither-confirmed"] += 1
        runs.append({
            "n": n,
            "class": kind,
            "inFlight": kind_note,
            "holders": holders,
            "postedApartments": posted_apts,
            "stateOne": state_one,
            "overlap": race.get("overlap"),
            "errors": race.get("errors"),
            "apartment12": {
                "status": (responses.get(12) or {}).get("status"),
                "body": (responses.get(12) or {}).get("body"),
            },
            "apartment3": {
                "status": (responses.get(3) or {}).get("status"),
                "body": (responses.get(3) or {}).get("body"),
            },
        })
        if n % 10 == 0:
            app.log(f"race progress {n}/100 counts={counts} violations={len(violations)}")
    obs["counts"] = counts
    obs["violationCount"] = len(violations)
    obs["violations"] = violations
    obs["runs"] = runs
    # keep command log from drowning; summary only. Full runs are in observation.json
    app.log(f"100-run counts={json.dumps(counts)} violations={len(violations)}")
    add_check(obs, "all 100 runs confirm exactly one household", counts["one-confirmed"] == 100 and len(violations) == 0, counts)
    add_check(obs, "no run confirms both", counts["both-confirmed"] == 0, counts)
    add_check(obs, "no run refuses both", counts["neither-confirmed"] == 0, counts)
    (WORK / "01-010" / "race-counts.json").write_text(
        json.dumps({"counts": counts, "violationCount": len(violations), "violations": violations}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def item_011(app: App, obs: dict):
    rec = book(app, 12, ROOM9, TUE, START)
    obs["exchanges"].append(rec)
    text = rec.get("bodyText") or ""
    obs["refusalBody"] = text
    obs["status"] = rec.get("status")
    # Exact refusal only, no grader answer and no separate configuration dump.
    target = WORK / "blind-review-011.txt"
    target.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
    obs["blindReviewPath"] = str(target)
    obs["blindReviewBytes"] = target.read_bytes().decode()
    add_check(obs, "refusal text collected for blind review", bool(text) and rec.get("status") not in (None, 0), {
        "status": rec.get("status"),
        "bytes": len(text),
    })
    obs["verdictNote"] = "usability verdict not judged; blind subagent review required"


ITEMS = [
    ("01-001", 18101, item_001),
    ("01-002", 18102, item_002),
    ("01-003", 18103, item_003),
    ("01-004", 18104, item_004),
    ("01-005", 18105, item_005),
    ("01-006", 18106, item_006),
    ("01-007", 18107, item_007),
    ("01-008", 18108, item_008),
    ("01-009", 18109, item_009),
    ("01-010", 18110, item_010),
    ("01-011", 18111, item_011),
]


def main():
    import sys
    selected = sys.argv[1:]
    summary = []
    for item, port, fn in ITEMS:
        if selected and item not in selected:
            continue
        print(f"=== {item} port {port} ===", flush=True)
        obs = run_item(item, port, fn)
        failed = [c for c in obs.get("checks", []) if not c["ok"]]
        print(f"{item} checks={len(obs.get('checks', []))} failed={len(failed)} error={obs.get('error')}", flush=True)
        for c in obs.get("checks", []):
            print(f"  [{'PASS' if c['ok'] else 'FAIL'}] {c['name']}", flush=True)
        summary.append({"item": item, "failed": [c["name"] for c in failed], "error": obs.get("error")})
    (WORK / "probe-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
