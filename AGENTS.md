# Ratchet

Tracks OpenCode work as a tree of tasks, follows the pull requests and other
resources each task touches, and wakes the session or person who acts next. The
design, what is built and what is open are in [docs/design.md](docs/design.md).

TypeScript with Effect v4, run by `celld dev`. `src/hub` holds tasks, sessions
and pull requests as `effect-machine` machines, one cell each. `src/gateway`
holds every connection to the outside: OpenCode and GitHub. `src/protocol` holds
what the two say to each other.

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
