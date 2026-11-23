# `loyly/no-deep-project-imports`

## Why

`project/loyly/` is the public product surface. Deep imports
(`project/loyly/identity.ts`) couple callers to internal file splits and make
refactors harder for agents.

## What to do

```ts
import { BLIND_ITEM_ID } from './project/loyly/index.ts';
```

Exception: files under `project/loyly/` may import sibling modules.

## Severity

`error` for pi-durable adapters outside `project/loyly/`.
