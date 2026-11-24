# centinela-memory

Shared multi-project memory and base configuration for [Centinela](https://github.com/johnny4young/centinela).

## Layout

- `base.json` — Fleet defaults inherited by project repos via `"extends": "johnny4young/centinela-memory/base.json@main"`.
- `learnings/global.json` — Engineering rules that apply across every repository regardless of stack.
- `learnings/stacks/<stack>.json` — Stack-specific rules loaded only when detected (`javascript`, `typescript`, `electron`, `react`, `node-server`, `swift`, `go`).

## How repositories connect

In any repository's `.github/centinela.json`:

```json
{
  "extends": "johnny4young/centinela-memory/base.json@main"
}
```

Ensure the Centinela GitHub App is installed on both the target repository and `centinela-memory`, and set the repository variable `CENTINELA_MEMORY_REPO=centinela-memory` (or pass `shared-memory-repo: centinela-memory`).
