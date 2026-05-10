# nxt

An open, extensible, smarter monorepo task runner.

## Why

Existing monorepo tools work, but they ask you to buy in: opaque caches, proprietary
plugin APIs, generators that own your project shape, and config that's awkward to
introspect or compose. `nxt` is built on the opposite premises:

- **Open** — every behaviour is described by plain config and documented protocols.
  Nothing about your project's shape is implicit.
- **No lock-in** — tasks are just commands. Caching, scheduling, and graph analysis
  are layers _on top of_ your existing scripts, not replacements for them.
- **Extensible** — first-class plugin contract. The same APIs `nxt` itself uses are
  available to userland.
- **Smarter** — content-addressed caching, precise input tracking, parallel
  scheduling that understands your real dependency graph (not just `package.json`).

This repo is the monorepo for the `nxt` toolchain itself.

## Packages

| Package        | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `@nxt/config`  | Project & workspace config types and helpers.      |
| `@nxt/core`    | Engine: graph, scheduler, cache, task execution.   |
| `@nxt/cli`     | The `nxt` command-line interface.                  |

## Status

Pre-alpha. Nothing is stable yet. The base scaffolding is in place; task config
shape, cache design, and scheduler are being designed in the open.

## Development

```sh
pnpm install
pnpm build       # tsc -b across workspace
pnpm typecheck
pnpm test
```

## License

MIT
