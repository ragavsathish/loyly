# Löyly

A working sauna booking workbench built from all five ready-for-development slices in `docs/plan/`. Node.js 18.19+; no runtime or acceptance-suite dependencies, compilation, downloads or external services.

```sh
/path/to/impl/test.sh
/path/to/impl/start.sh 8901
# open http://127.0.0.1:8901/
```

Both entrypoints work from any directory. The server stays in the foreground. The suite creates isolated houses over HTTP in a temporary record under `impl/`, tests races with overlapping requests, and removes its temporary record afterward. It never alters the app's normal record.

## Use it

- **Weekly schedule** reads per-resource calendars; request free windows, or use **Request a slot** to test a closed-day request. An actionable refusal supplies an explicit room, weekday and start and a request-alternative button.
- **My bookings** shows the selected household's current holdings. Release a named date as FREE/SALE without losing the weekly right, or give up the whole holding.
- **One-week offers** shows offers, takers, withdrawals and unclaimed outcomes. Switch household context to take an offered week.
- **Queue & notices** exposes scoped FIFO queues, explicit scarcity evaluation, holder/queue-head choices, pending claims and declines. A pending claimant does not become the holder early.
- **List, heat & billing** reads all three views from the record. Choose the date to inspect transfers or expired offers. Blank date is the standing/upcoming overview, with resale billing signals included. No equipment commands or payments are performed.
- **House policy** creates independent houses, revises effective-dated policy and advances the administrative clock. The current rule's authority is required. Notice deadlines and previous decisions remain pinned to their versions. Calendar JSON supports either `days` + `starts`, or explicit classed `windows`.
- **History & disputes** exposes exact confirmation/change snapshots, refusal evidence, policy versions and disputes opened by the configured first-stop role.

Three initial configurations are provided: manager-mediated Soukanvuori, an opt-in self-service example, and a Masthugget family-time example. Extra sample windows are explicitly illustrative configuration, not undocumented claims about the real houses. Resource groups, not the entire house by default, scope the queue and scarcity rule. A notice does not invent a fallback holding if neither holder nor queue-head chooses one.

The UI and full JSON interface share one set of domain decisions. See **API & guide** (`/api-docs`) for endpoint bodies and independent house setup. `contract.json` describes named slot values. The second-slot/full-schedule guard exists only in the booking decider.

## Persistence and concurrency

`impl/data/record.json` is the normal persistent record. Override with `LOYLY_DATA=/absolute/path/record.json` (the suite uses a separate temporary path). Writes use a temporary file and atomic rename before answering. The one-process server performs each decision and write synchronously, so an asynchronous request body cannot interleave the availability check and confirmation. All three views are computed on reads from bookings and occurrence transitions, not separately stored or synchronized.

Do not run multiple writers against one record. Preserve the record when upgrading or restarting; removing it deliberately starts a new installation. Existing-booking migrations under new policy are outside this cut.

Calendar coordinates are distinct from UTC decision/clock instants. All clock controls and calendar date boundaries in this workbench use UTC, stated in the UI and API guide.

## Verification

`test.sh` discovers 54 HTTP checks covering all 47 stamped scenario IDs, including 100 standing-slot races, a released-occurrence race, lifecycle clocks, role/calendar isolation, policy history and a process restart. The `@item-01-011` test checks the refusal and suggested-request HTTP replay; **the fresh independent blind-agent judgment belongs to the independent grading stage by operator direction and remains listed in `UNCARRIED.md`**. No builder-side judgment is claimed, and the app suite does not install or run a local judge or model.

`browser-smoke.mjs` is an additional manual browser probe, not a runtime dependency or a prerequisite for the portable HTTP suite. It was run in this builder using separately provisioned Playwright and Chromium. To repeat with your own browser tooling, install Playwright without changing the package manifest, set `CHROMIUM` to its executable, start a **fresh disposable record**, and run it from `impl/` with `URL=http://127.0.0.1:8901`. Screenshots are in `evidence/`. This probe creates bookings and is not safe to run against a live cooperative's record.

## Security boundary

This cut is a local administrative/product workbench, not an authenticated multi-user deployment. Household, booker standing, policy authority and dispute role are explicit caller context. The role rules are checked, but credentials are not authenticated. Do not expose the server to an untrusted network. Numeric prices, sale proceeds, payment collection, invoice delivery, heater network control, penalties and subtenant rules are intentionally not inferred.
