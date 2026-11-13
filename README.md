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

The service runs from its own checkout, `~/.local/share/ratchet/live`, so an
edit in a working checkout never reaches the sessions that call it. A systemd
user unit runs `celld dev` there on `http://127.0.0.1:9876`. The unit is in
`nix/ratchet.nix` of my dotfiles.

```sh
scripts/deploy.sh   # move the service to origin/main, after the checks pass here
```

The first run creates the checkout. `scripts/dev-vars.sh` writes its
`.dev.vars`: the OpenCode URL and password, and the lines of
`~/.config/ratchet/secrets.env` and `settings.env`.

| Route | Does |
| --- | --- |
| `GET /gateway/opencode` | Starts the OpenCode connection if it is not running, and reports it |
| `GET /tree` | Returns the task forest |
| `GET /prs` | Returns the pull requests tasks follow |
| `POST /mcp` | The tools sessions call |
| `GET /gateway/proxy` | Says whether Ratchet is signed in to the webhook proxy |
| `GET /gateway/proxy/login` | Starts a sign-in and returns the address to open in a browser |
| `GET /gateway/proxy/callback` | Finishes the sign-in. The browser is sent here, on the machine Ratchet runs on |

State lives in `.celld/dev` of the service's checkout.

`scripts/scratch.sh` runs a scratch Ratchet with empty state against a stand-in
for OpenCode, for trying a change end to end before it is deployed.

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
