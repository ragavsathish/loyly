# Löyly HTTP interface

Run `./impl/test.sh`, then `./impl/start.sh 8901`. Requires Node.js 18+; no downloaded packages, services or build artifacts. Scripts resolve their own directory and work from any working directory. The browser at `/` uses this same public JSON API. This is a local demonstration: role fields represent acting parties, not authenticated credentials. Do not expose it as a production multi-tenant service.

## Record and time

The server is a single writer. Each command makes an availability/role/policy decision and commits the booking history to `impl/data/record.json` using atomic rename before responding. No await separates checking and committing. Concurrent HTTP requests are accepted, but their transactions run serially. The posted list, heater schedule and billing signal have no stored tables or writable endpoints. They are computed from bookings, release decisions and notices at read time. Run only one app process per record file. Set `LOYLY_DATA` to choose a different record file, under `impl/` for this build.

Time-of-day values use `HH:mm`. A standing slot is `{resource, weekday, start}`, an occurrence is `{resource, date, start}`. Dates are `YYYY-MM-DD`; time instants use ISO UTC. The example uses a UTC civil calendar, not Finnish time-zone conversion. Duration belongs to the resource. Slot windows and time classes are configured, not generated from assumed opening hours. Past decisions retain their policy version; revisions do not edit history.

`POST /api/clock {"now":"2030-01-01T00:00:00Z"}` sets a persistent scenario clock. `{"now":null}` returns to real time. Due transitions are settled on the next HTTP operation. Production authentication and external scheduling services are outside this cut. An untaken offer expires at its start. A selected holding lapses at its recorded loss instant, not the time the view is read.

## Reading

- `GET /api/houses` → `{houses}` with resource calendars, all policy versions and `currentPolicy`.
- `GET /api/households?house=ID` → `{households}`.
- `GET /api/schedule?house=ID` → `{slots}`: configured weekly windows, each free or held.
- `GET /api/bookings?house=ID` → `{bookings}` including ended holdings and per-booking history.
- `GET /api/releases?house=ID` → `{releases}` with derived `state`.
- `GET /api/queue?house=ID&group=GROUP` → `{entries,head}`. Entries retain withdrawn/claimed history; head is the earliest eligible waiting entry in that group.
- `GET /api/notices?house=ID` → `{notices}` including current `chooser`, `offeredTo`, selected holding and pending successor.
- `GET /api/views?house=ID[&date=YYYY-MM-DD]` → `{posted,heater,billing}`. Undated: standing schedule plus separately dated bookings. Dated: occurrence list and heating with release overrides. Billing includes normal standing fees and, for that date, any separate resale charges. FREE raises no occurrence charge for the taker. An untaken offer has no user and no heating signal. Fee amounts are deliberately absent; billing resolves the price reference.
- `GET /api/state` → entire source record and current `clock`, for history/operator inspection.

## Commands

Use `Content-Type: application/json`. Errors have HTTP 400/403/404/409 with `{code,reason}`. Booking refusals additionally return an immutable `decision` containing request, reason, time and policy version. Closed-day errors include a free configured `alternative` when one exists; the prose names its resource, weekday and start. Class-cap errors include `existingBooking`. Successful creations return 201, other commands 200.

### Standing and dated bookings

`POST /api/bookings`

```json
{
  "house": "soukanvuori",
  "household": "12",
  "resource": "ph8",
  "weekday": "Tuesday",
  "start": "17:00",
  "operator": "manager"
}
```

Returns `{booking}`. Replace `weekday` with `date` for a one-occurrence booking. The household must be registered and its tenure role permitted by the effective policy. In a manager-mediated house, `operator` must match the configured booking role. A second standing holding is possible while a free configured window remains. A full schedule refuses without suggesting unavailable alternatives. There is no arbitrary hard maximum of two.

`POST /api/bookings/BOOKING/give-up {"household":"12"}` ends that holding and future standing charges, retaining its history.

### One-week offers

- `POST /api/releases {"booking":"BOOKING","household":"12","date":"2030-01-08","mode":"FREE"}` → `{release}`. Use `SALE` for paid transfer. The date must match the standing weekday, be future, and have no outstanding offer for that occurrence.
- `POST /api/releases/RELEASE/take {"household":"3"}` → `{release}` with one taker, policy version and house price reference. The taker must be an eligible household of the holding's house. Class caps also apply to taking an occurrence.
- `POST /api/releases/RELEASE/withdraw {"household":"12"}` restores the holder's use only if untaken and before its start.

### Scoped scarcity queue and notices

- `POST /api/queue {"house":"ID","group":"A","household":"3"}` → `{entry}`. Only self-service houses offer a queue; FIFO is by accepted sequence. A household can wait in a named eligible group without affecting other groups.
- `POST /api/queue/ENTRY/withdraw {"household":"3"}`. Cancels this queue entry, not a notice.
- `POST /api/scarcity/evaluate {"house":"ID","group":"A"}` → newly created `{notices}`. Full standing capacity plus eligible waiting demand puts each multi-holder under at most one active notice. Both deadlines and governing policy are recorded together. Releases do not count as free standing capacity.
- `POST /api/notices/NOTICE/choose {"household":"12","booking":"BOOKING"}`. Before the choose deadline, the holder chooses. From that deadline, only the eligible queue-head may choose. The selected holding remains usable until lapse.
- `POST /api/notices/NOTICE/claim {"household":"3","action":"confirm"}` or `"decline"`. Confirmation is only a pending succession. Decline offers the selected holding to the next eligible queue entry. If none confirms, the selected holding returns to the pool at lapse. A withdrawn pending claimant is cleared without changing the deadlines.

This cut defines lapse of a **selected** holding. It does not invent a random/default selection if both holder and queue-head fail to exercise the choice right. Such a notice remains visible awaiting selection.

### Houses, roles and rule history

`POST /api/households {"house":"ID","id":"12","role":"tenant"}` registers a household. Households are scoped by house and identifier, not people.

`POST /api/houses` accepts this complete editable configuration (the browser includes self-service and family-time examples):

```json
{
  "id": "example",
  "name": "Example cooperative",
  "resources": [
    {
      "id": "room",
      "name": "Dressing room",
      "sauna": "Sauna A",
      "group": "A",
      "duration": 90,
      "days": {
        "Saturday": [
          { "start": "17:00", "class": "family" },
          { "start": "18:30", "class": "family" }
        ]
      }
    }
  ],
  "policy": {
    "version": "v1",
    "authority": "board",
    "effective": "2020-01-01T00:00:00Z",
    "bookerRoles": ["tenant"],
    "route": "self-service",
    "bookingRole": "manager",
    "operationsRole": "caretaker",
    "billingRole": "billing",
    "disputeRole": "caretaker",
    "chooseDays": 14,
    "noticeDays": 30,
    "caps": { "family": 1 },
    "priceReference": "standing-price",
    "salePriceReference": "resale-price"
  }
}
```

The supplied times are demonstration configuration, not additional corpus claims. The initial Soukanvuori house has ph8 Tuesday and ph9 Thursday/Friday/Saturday, manager mediation, shareholder bookers, 90-minute slots, and no queue. ph8's other days are deliberately not invented. Additional example slot starts are editable fixture choices.

`POST /api/houses/ID/policies {"actor":"board","policy":{...complete new policy...}}` records a new unique version with a future effective instant and authority. `actor` must match the current policy authority. Decisions use the rule effective at their decision instant. Existing decisions and notice clocks keep their versions. A class cap counts confirmed active/upcoming class bookings until their end; unrelated classes and houses never consume it.

`POST /api/disputes {"booking":"BOOKING","role":"manager","reason":"My slot vanished"}` → `{dispute,evidence}`. The opening role must match the house's configured first stop. Evidence includes confirmation/change events, applicable policy versions and related notices. The full record retains prior refusals even after rule revisions.

No fee collection, hardware control, invoice delivery, exceptional penalties, existing-booking policy migration or production identity system is claimed.
