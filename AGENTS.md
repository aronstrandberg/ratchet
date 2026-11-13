# Ratchet

Tracks OpenCode work as a tree of tasks, follows the pull requests and other
resources each task touches, and wakes the session or person who acts next. The
design, what is built and what is open are in [docs/design.md](docs/design.md).

TypeScript with Effect v4, run by `celld dev`. `src/hub` holds tasks, sessions
and pull requests as `effect-machine` machines, one cell each. `src/gateway`
holds every connection to the outside: OpenCode and GitHub. `src/protocol` holds
what the two say to each other.

## Layout

Each half has the same four kinds of module. Name a new file after what it
holds, and put it where its kind lives:

| Kind | Hub | Gateway |
| --- | --- | --- |
| Domain: pure rules and state machines | `task.ts`, `session.ts`, `pull-request.ts`, `wake-policy.ts` | none: the gateway decides nothing |
| Application service: an operation and the order of its effects | `tasks.ts`, `pull-requests.ts` | `session-sync.ts`, `pull-request-poll.ts` |
| Port: what an operation needs from outside, in its own words | `session-control.ts`, `pull-request-source.ts` | `hub-reports.ts` |
| Adapter: one technology behind a port or in front of a service | `cells.ts`, `index-store.ts`, `persistence.ts`, `gateway-binding.ts`, `mcp.ts`, `entrypoint.ts` | `opencode.ts`, `github.ts`, `hub-binding.ts`, `entrypoint.ts` |
| Composition root: reads `Env`, parses settings, builds the layers | `cluster.ts` | `runtime.ts`, the Durable Object classes |

A service is an Effect service: `Interface`, `Service`, `make`,
`layerWithoutDependencies` and, where it has a production assembly, `layer`.
Import a service module as a namespace (`import * as Tasks from "./tasks.ts"`).
Only a composition root reads `Env` or chooses a layer. A failure a caller can
meet is a tagged error in the return type, never `unknown`. Task, session and
pull request IDs are branded types from `src/protocol`: parse them where they
come in.

The words this repository uses are in [GLOSSARY.md](GLOSSARY.md). Use them in
code, comments and messages.

## Stored state

A cell stores its state and its events as JSON. A field you add to a state or an
event needs a decoding default (`Schema.withDecodingDefaultKey`), or cells
stored before the change no longer load. Add the stored shape to
`src/hub/stored-state.test.ts`.

## Skills

The skills in `.agents/skills` are the standards for this repository. Load them
before the work they cover:

- `coding-standards` before you write or refactor TypeScript.
- `effect-service-design` before you add or change a service, a Layer, or how
  dependencies reach the code that uses them.
- `domain-modeling` when a term or a lasting decision changes.

## Checks

`bun run check` runs the lint, the Markdown format check, the type check and the
tests. lefthook runs the same before each commit. Fix a finding in the code: do
not turn a rule off, lower its severity or add a cast to pass.

## The running service

Every OpenCode session on this machine calls the Ratchet at
`http://127.0.0.1:9876`. It runs from its own checkout, not this one, and
`scripts/deploy.sh` moves it to `origin/main`. Do not start a second `celld dev`
against the same OpenCode service: it would write to the same sessions.

To try a change end to end, run `scripts/scratch.sh`. It starts a Ratchet with
empty state on port 9877 against a stand-in for OpenCode on port 9878, and reads
the real GitHub. The header of `scripts/fake-opencode.ts` says how to add
sessions and send events. Tests of the hub run on `src/hub/test-hub.ts`: the
real services, cells in memory, the index on SQLite in memory.
