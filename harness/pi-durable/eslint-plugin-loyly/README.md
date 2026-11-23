# eslint-plugin-loyly

Harness-local ESLint rules that encode Löyly / Pi-durable conventions for
agents — same idea as [Factory’s `@factory/eslint-plugin`](https://github.com/Factory-AI/eslint-plugin):
turn architecture into machine-checked feedback instead of importing a foreign
preset wholesale.

## Rules

| Rule | Purpose |
|------|---------|
| `loyly/no-product-literals` | Product IDs/paths belong in `project/loyly/` |
| `loyly/no-deep-project-imports` | Callers use the `project/loyly` barrel |

Each rule has a short `rules/<name>.md` agents can read when fixing violations.

## Usage

Wired from `eslint.config.mjs` in this package. Run `npm run lint`.
