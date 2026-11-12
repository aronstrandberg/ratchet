# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
`13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), MIT-licensed. `LICENSE`
is that repository's license.

Copied with the repository's `skills/install-anti-slop/scripts/install.mjs`. The
files are identical to `src/` at that commit, without the `*.test.ts` files.

Installed plugins, registered in `oxlint.config.ts`:

- `anti-slop`: `tools/oxlint/anti-slop/index.ts`, every rule enabled.
- `anti-slop-effect`: `tools/oxlint/anti-slop/effect/index.ts`, every rule
  enabled.

`oxlint` and `@oxlint/plugins` are pinned to the same exact version in
`package.json`. Upgrade them together.

Deviations from upstream: none.
