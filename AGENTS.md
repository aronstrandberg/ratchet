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
| Domain: pure rules and state machines | `task.ts`, `session.ts`, `pull-request.ts`, `linear-issue.ts`, `incident.ts`, `commit-builds.ts`, `commit-runs.ts`, `subscribers.ts`, `wake-policy.ts` | none: the gateway decides nothing |
| Application service: an operation and the order of its effects | `tasks.ts`, `resources.ts` | `session-sync.ts`, `resource-reads.ts`, `resource-poll.ts`, `commit-builds.ts`, `commit-runs.ts` |
| Port: what an operation needs from outside, in its own words | `session-control.ts`, `resource-source.ts` | `hub-reports.ts` |
| Adapter: one technology behind a port or in front of a service | `cells.ts`, `index-store.ts`, `persistence.ts`, `gateway-binding.ts`, `mcp.ts`, `entrypoint.ts` | `opencode.ts`, `github.ts`, `linear.ts`, `incident-io.ts`, `buildkite.ts`, `spacelift.ts`, `mcp-client.ts`, `grant.ts`, `sign-ins.ts`, `hub-binding.ts`, `entrypoint.ts` |
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

## A new kind of resource

A kind of resource is five things: its reference, facts and key in
`src/protocol`, a cell with its changes in `src/hub` (`linear-issue.ts` is the
shortest example), its three entries in `src/hub/resources.ts`, its adapter in
`src/gateway` with its entry in `resource-reads.ts`, and its stand-in in
`scripts/fake-outside.ts`. An observation carries who did something and never
what they wrote.

The gateway holds no API key for a system that has an MCP server with OAuth. It
signs in as me (`grant.ts`, one `SignIn` object per system) and calls the
server's tools with `mcp-client.ts`, which parses each answer with a schema. A
new system of that kind is a name in `systems.ts`, its address in `config.ts`
and its adapter. `fake-sign-in.ts` and `fake-mcp.ts` are the stand-ins the tests
and the scratch Ratchet serve. Spacelift's sign-in is for its GraphQL API, which
`spacelift.ts` calls directly: `fake-spacelift.ts` is its stand-in.

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
`scripts/deploy.sh` moves it to `origin/main` and restarts its unit,
`ratchet.service`. Do not start a second `celld dev` against the same OpenCode
service or on the same state directory: two of them write to the same sessions
and corrupt each other's leases.

A restart is not free. Every cell wakes again from celld's local store, which
takes minutes while that store is large, and tool calls from sessions time out
meanwhile. So deploy once for several changes, not once per change. celld's
messages are in `~/.local/state/ratchet/celld.log`.

celld's local store only grows, and cells wake more slowly as it does. When the
store is too large to wake from, or its state is damaged, start from empty
state: `scripts/export.sh` saves the tasks and what they follow, the unit stops,
`.celld` in the service's checkout moves aside, the unit starts with
`WAKE_SESSIONS=` empty, `scripts/import.sh <directory>` puts the export back,
and the unit restarts with the wake setting restored. Tasks that sessions
started get new IDs. Open questions and wake-ups not yet delivered are lost.

To try a change end to end, run `scripts/scratch.sh`. It starts a Ratchet with
empty state on port 9877 against a stand-in for OpenCode on port 9878, and reads
the real GitHub. The header of `scripts/fake-outside.ts` says how to add
sessions and send events. Tests of the hub run on `src/hub/test-hub.ts`: the
real services, cells in memory, the index on SQLite in memory.
