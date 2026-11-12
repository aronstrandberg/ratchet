# Ratchet

Tracks my OpenCode work as a tree of tasks, attaches the pull requests, tickets
and threads each task touches, and wakes the session or person who acts next.

The design is in [docs/design.md](docs/design.md). So far it mirrors the
OpenCode session tree into tasks.

It runs on [celld](https://celld.dev) on my dev VM, written in TypeScript with
Effect v4: `hub` holds the tasks as typed actors, and `gateway` holds every
connection to the outside.

## Run it

Needs `celld` (v0.6.3) and `bun` on `PATH`, and a running OpenCode service.

```sh
bun install
scripts/dev-vars.sh   # writes .dev.vars with the OpenCode URL and password
bun run dev           # celld dev on http://127.0.0.1:9876
```

| Route | Does |
| --- | --- |
| `GET /gateway/opencode` | Starts the OpenCode connection if it is not running, and reports it |
| `GET /tree` | Returns the task forest |

State lives in `.celld/dev`. `celld dev . --clean` starts from nothing.

## Checks

`bun run check` runs everything a commit must pass:

| Command | Does |
| --- | --- |
| `bun run lint` | oxlint with the [anti-slop](https://github.com/dmmulroy/anti-slop) rules, vendored in `tools/oxlint/anti-slop`. `bun run lint:fix` adds the blank lines it asks for |
| `bun run fmt:check` | [rumdl](https://github.com/rvben/rumdl) on the Markdown. `bun run fmt` rewrites it |
| `bun run typecheck` | `tsc` |
| `bun test` | The tests |

[lefthook](https://lefthook.dev) runs these before each commit, from
`lefthook.yml`. It lints and formats the staged files and stages what it fixed.
`bun install` installs the hook.
