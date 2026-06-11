#!/usr/bin/env bun
import { run } from './cli/index.js'
import { UserError } from './util/index.js'

// Wrapped in an explicit async main so `bun build --compile` accepts
// the file. The compile target doesn't allow top-level await.
async function main(): Promise<void> {
  try {
    process.exit(await run(process.argv.slice(2)))
  } catch (err) {
    // UserError (workspace not found, cycle, config invalid, ...) —
    // print the message only; the stack is noise the user can't act
    // on. Everything else gets the full stack so internal bugs are
    // debuggable.
    if (err instanceof UserError) {
      process.stderr.write(`vx: ${err.message}\n`)
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      process.stderr.write(`vx: ${message}\n`)
    }
    process.exit(1)
  }
}

void main()
