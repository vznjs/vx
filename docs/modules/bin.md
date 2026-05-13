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
