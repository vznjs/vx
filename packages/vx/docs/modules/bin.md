# `src/bin.ts` — binary entry point

## Purpose

The shebang script invoked when the user runs `vx`. Forwards
`process.argv` to `cli.run`, prints errors with the right level of
detail, and sets the right exit code.

## Behavior

A lone `--version` (or `version`) is answered from `version.ts` before
anything else loads: the dispatcher and the util barrel were 20 ms of
its 28 (#1961). Otherwise `main()` imports the dispatcher, forwards
`process.argv.slice(2)` to it (`cli/index.ts`'s `run`) and sets `process.exitCode` to the code it returns, then lets
the event loop drain — nothing calls `process.exit` or `stdout.end`.
Bun drops what a pipe has not yet taken when `process.exit` follows a
large write (300 KB written then exit delivered 64 KiB; `vx history
--format json` on a 300-project workspace was cut mid-string,
2026-09-15), and on 1.3.11 `stdout.end`'s callback fired early too
(2 MiB written, 214 KB delivered, 2026-09-20); draining does not depend
on when a runtime calls a pipe flushed. A thrown error is printed and
`exitCode` is 1: a `UserError` (`isUserError`,
so a plugin's own class of that name counts) as its message alone,
prefixed `vx:` unless the message already names the verb (`vx why: …`);
a file-system refusal (`isFsRefusal`) as its message plus the hint that
names the knob; anything else with its stack, since an internal bug
must stay debuggable. Both streams get an `error` listener before any
of that: a reader that leaves (`vx run build | head -1`) turns every
later write into EPIPE, and an unheard `error` event killed a green
run with a stack and exit 1 (2026-09-16); with the listener the run
finishes, saves, releases its lock and exits with its own verdict.
A loop that drains before the verb settles (a plugin hook whose promise
never resolves) is a failure: a `beforeExit` listener says so on stderr
and sets exit 1 (item 921). The wrapper is an explicit `async main()`
because `bun build --compile` refuses top-level await.

Before any verb runs, bin.ts registers the **core alias**
(`cli/core-alias.ts`): a Bun virtual module for the exact specifier
`@vzn/vx`, served lazily from this process's own façade. Every plugin
package, workspace file and project config that imports `@vzn/vx`
then gets the running core — one module state per process, and in the
compiled binary no second copy of core transpiled from `node_modules`
(a plugin package's import: 20–25 → 2–3 ms; a live-evaluated config's:
22 → 2 ms; a workspace file with no `@vzn/vx` installed at all loads).
`tests/core-alias.test.ts` pins it differentially against a fake
`node_modules/@vzn/vx`.

The compiled binary also carries the plugin packages
`scripts/baked-plugins.ts` lists (vx-github, vx-lockfile, vx-mcp,
vx-otel, vx-schedule-history) compiled in (owner, 2026-10-06: nothing to
install, they are right there). bin.ts registers each as a virtual
module too (`registerBakedPlugins`), so `import { bun } from
'@vzn/vx-lockfile'` works with nothing installed and gets the binary's
copy over any installed one, as `@vzn/vx` does; the config loader's
refusal of an unprovided bare import exempts them (`provideFromHost`).
`scripts/compile.ts` rewrites each one's `definePlugin(import.meta, …)`
to name its package, since a bundled module's `import.meta.dir` is
`/$bunfs/root`. A workspace using all five: `vx show` 37 → 31 ms
(2026-10-06). vx-reapi and vx-migrate are not baked: each reads files
beside its source at run time. In source `baked.ts` is an empty table;
`scripts/check-binary.ts` runs a baked plugin with nothing installed and
over a fake installed copy.

`vx` is shipped two ways:

1. **As a Bun-runnable script** — `bin: "src/bin.ts"` in `package.json`,
   shebang `#!/usr/bin/env -S bun --no-env-file --no-install`. Bun runs the
   TypeScript directly.
2. **As a standalone binary** — `bun scripts/compile.ts <target>
dist/vx-<target>`: `Bun.build` with the flags of `bun build --compile
--no-compile-autoload-dotenv --compile-autoload-package-json --minify
--bytecode --target=bun-<target> src/bin.ts`, plus the baked plugins
   below. The cross-target binaries are published on each GitHub release.

Both switches keep Bun from loading `.env`, `.env.local` and
`.env.<NODE_ENV>` from the working directory into vx's own environment,
where every `passThrough` and essential variable and every `VX_*` switch
is read: a task saw a value no shell had set (item 1089). Running the
source as `bun src/bin.ts`, as this repository's own gate does, is not
the shebang, and Bun loads a `.env` there.

`--compile-autoload-package-json` makes the binary read an on-disk
package's `package.json` when it resolves one. Without it a compiled
Bun resolves a package only by its root `index.*`, ignoring `main` and
`exports`: a config importing `@vzn/vx-reapi` failed on
`cannot find '@grpc/grpc-js'` (`main: build/src/index.js`), though
`bun src/bin.ts` loaded it (#1891). `scripts/check-binary.ts` holds it.

`--no-install` keeps Bun from auto-installing a bare import no
`node_modules` provides: a helper a config imports fetched the package
from the registry and ran it (L-22; the config file itself was already
refused before evaluation). The npm launcher's source fallback passes
both flags; a compiled binary never auto-installs. `bun src/bin.ts` is
not the shebang here either.

## What this does NOT do

- **Doesn't parse argv** past the lone `--version` it answers. That's
  `cli/index.ts` (dispatcher) and `cli/<sub>.ts` (per-subcommand
  parsers).
- **Doesn't import the orchestrator directly.** The CLI does. This
  keeps `bin.ts` tiny and lets tests import `cli/index.ts` without going
  through a process boundary.

## Tests

No unit file: the end-to-end suites spawn `src/bin.ts` as the real
CLI (`tests/cli.test.ts` and the dozens that drive a fixture through
it), the piped-stdout flush and the EPIPE listener each have their pin
there, and `bun src/bin.ts run <task>` is how CI invokes vx.
