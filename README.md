# Ratchet

Tracks my OpenCode work as a tree of tasks, attaches the pull requests,
tickets and threads each task touches, and wakes the session or person who
acts next.

Nothing is built yet. The design is in [docs/design.md](docs/design.md).

It runs on [celld](https://celld.dev) on my dev VM, as two workers written in
TypeScript with Effect v4: `hub` holds the tasks and resources as typed
actors, and `gateway` holds every connection to the outside.
