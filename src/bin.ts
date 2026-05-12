#!/usr/bin/env bun
import { run } from './cli.js'
import { UserError } from './util/errors.js'

try {
  process.exit(await run(process.argv.slice(2)))
} catch (err) {
  // UserError (workspace not found, cycle, config invalid, ...) — print
  // the message only; the stack is noise the user can't act on.
  // Everything else gets the full stack so internal bugs are debuggable.
  if (err instanceof UserError) {
    process.stderr.write(`vx: ${err.message}\n`)
  } else {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`vx: ${message}\n`)
  }
  process.exit(1)
}
