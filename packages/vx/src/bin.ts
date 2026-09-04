#!/usr/bin/env bun
import { run } from './cli/index.js'
import { isUserError } from './util/index.js'

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
    if (isUserError(err)) {
      // A message that already names the tool (`vx why: …`, thrown by a verb
      // that wants its own name in the line) is printed as it is; prefixing
      // it produced `vx: vx why: …` (walkthrough, 2026-09-04).
      const m = err.message
      process.stderr.write(m.startsWith('vx ') ? `${m}\n` : `vx: ${m}\n`)
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      process.stderr.write(`vx: ${message}\n`)
    }
    process.exit(1)
  }
}

void main()
