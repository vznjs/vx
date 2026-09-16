# `src/bin.ts` — binary entry point

## Purpose

The shebang script invoked when the user runs `vx`. Forwards
`process.argv` to `cli.run`, prints errors with the right level of
detail, and exits with the right code.

## Behavior

`main()` forwards `process.argv.slice(2)` to the dispatcher (`cli/index.ts`'s
`run`) and, on a code, ends stdout and exits in its callback:
Bun drops what a pipe has not yet taken when `process.exit` follows a
large write (300 KB written then exit delivered 64 KiB; `vx history
--format json` on a 300-project workspace was cut mid-string,
2026-09-15), and `end`'s callback fires once the pipe holds it all. A
thrown error is printed and the exit is 1: a `UserError` (`isUserError`,
so a plugin's own class of that name counts) as its message alone,
prefixed `vx:` unless the message already names the verb (`vx why: …`);
a file-system refusal (`isFsRefusal`) as its message plus the hint that
names the knob; anything else with its stack, since an internal bug
must stay debuggable. Both streams get an `error` listener before any
of that: a reader that leaves (`vx run build | head -1`) turns every
later write into EPIPE, and an unheard `error` event killed a green
run with a stack and exit 1 (2026-09-16); with the listener the run
finishes, saves, releases its lock and exits with its own verdict.
The wrapper is an explicit `async main()` because `bun build --compile`
refuses top-level await.

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

`vx` is shipped two ways:

1. **As a Bun-runnable script** — `bin: "src/bin.ts"` in `package.json`,
   shebang `#!/usr/bin/env bun`. Bun runs the TypeScript directly.
2. **As a standalone binary** — `bun build --compile --bytecode src/bin.ts
--outfile dist/vx-<target>`. The cross-target binaries are published
   on each GitHub release.

## What this does NOT do

- **Doesn't parse argv.** That's `cli.ts` (dispatcher) and
  `cli/<sub>.ts` (per-subcommand parsers).
- **Doesn't import the orchestrator directly.** The CLI does. This
  keeps `bin.ts` tiny and lets tests import `cli.ts` without going
  through a process boundary.

## Tests

No unit file: the end-to-end suites spawn `src/bin.ts` as the real
CLI (`tests/cli.test.ts` and the dozens that drive a fixture through
it), the piped-stdout flush and the EPIPE listener each have their pin
there, and `bun src/bin.ts run <task>` is how CI invokes vx.
