# `loyly/no-product-literals`

## Why

Löyly product identity (`01-011`, booking slice paths, panel plan filename, pending
blind evidence prefixes) must live in `project/loyly/`. Hard-coding those
strings in Pi adapters makes the harness project-specific again and breaks the
modularization agents are supposed to preserve.

## What to do

Import from `project/loyly`:

```ts
import { BLIND_ITEM_ID, DEFAULT_PANEL_PLAN } from './project/loyly/index.ts';
```

## Allowed locations

- `project/loyly/**` — the product module itself
- `test/**`, `fixture/**` — fixtures may use literal IDs
- Digest-pinned workers (`blind-agent-adapter.mjs`, `panel-*.mjs`) — byte-stable

## Severity

`error` for TypeScript/JavaScript adapters under `harness/pi-durable`.
