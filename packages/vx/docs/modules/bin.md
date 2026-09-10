# `src/bin.ts` — binary entry point

## Purpose

The shebang script invoked when the user runs `vx`. Forwards
`process.argv` to `cli.run`, prints errors with the right level of
detail, and exits with the right code.

## Behavior

```ts
#!/usr/bin/env bun
import { run as cliRun } from './cli.js'
import { UserError } from './util/errors.js'

async function main() {
  const exitCode = await cliRun(process.argv.slice(2))
  process.exit(exitCode)
}

main().catch((err) => {
  if (err instanceof UserError) {
    process.stderr.write(`vx: ${err.message}\n`)
    process.exit(1)
  }
  throw err // internal error → full stack
})
```

(actual file matches this shape; check `src/bin.ts` for the canonical
text.)

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

No dedicated tests for `bin.ts` itself — it's a one-line dispatch.
End-to-end behaviour is covered by the binary integration via the
release workflow (`bun src/bin.ts run <task>` is how CI invokes vx).
