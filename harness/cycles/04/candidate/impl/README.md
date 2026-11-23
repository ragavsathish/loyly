# Löyly

Run `./impl/test.sh`, then `./impl/start.sh 8901`. Open http://127.0.0.1:8901 for the house selector, weekly schedule, booking forms, and derived views. Node.js 22 or later suffices.

The server stores a single JSON record beside the server in `.loyly-record.json` by default. Set `LOYLY_RECORD` to use a separate file. Run one server process per record. The example calendars use configurable sample start times. Pukuhuone 8 opens Tuesday only in the supplied configuration. The house selector includes manager-mediated Soukanvuori, a Masthugget family-time example, and a self-service example without the cap.

The UI and API accept an apartment and acting role as inputs. Account authentication and external equipment or billing integrations are outside this build.

## HTTP interface

`GET /api` lists houses. All routes below use the `/api/{house}` prefix. POST requests take JSON. Booking policy refusals return a resident-readable message, reason, decision ID and policy version.

| Method and path | Purpose or request fields |
| --- | --- |
| GET /schedule | Per-room weekly availability, households and holding IDs |
| GET /route | House booking route, roles, local date and policy version |
| GET /views | Posted list, heater schedule, billing and offers. Add ?date=YYYY-MM-DD for a dated view. |
| POST /standing | resource, weekday, start, household, role |
| POST /occurrences | resource, date, start, household, role |
| POST /give-up | bookingId, household |
| POST /release | bookingId, date, household, mode (free or sale) |
| POST /take | offerId, household, role |
| POST /withdraw-offer | offerId, household |
| GET /queue | FIFO waiting entries keyed by eligible resource group |
| POST /queue | group, household, role |
| POST /withdraw-queue | group, household |
| POST /evaluate-scarcity | group, booking operator role |
| GET /notices | Notice history, deadlines, chooser, claimant, and pending successor |
| POST /choose | noticeId, bookingId, household |
| POST /claim | noticeId, household, decision (confirm or decline) |
| GET /policies | Current and recorded effective-dated policies |
| POST /policies | version, authority, effectiveAt (ISO 8601), role, changes (object) |
| GET /history | Decision events. Filter by bookingId or decisionId query parameter. |
| POST /disputes | bookingId and dispute role. Returns the booking evidence and policy versions. |

The resource field accepts either an ID or the dressing room's display name. For deadline exercises, launch with `LOYLY_RECORD=./.demo.json LOYLY_DEMO_NOW=2030-01-01T08:00:00Z`. In that mode, POST /clock with a JSON object containing an ISO 8601 `now` field advances the clock. An ordinary launch uses the system clock. Occurrence start times use the house time zone.

The suite names each of the 47 stamped scenarios. The closed-day test replays the alternative extracted from the refusal. The independent blind evaluation is performed by the gate.
