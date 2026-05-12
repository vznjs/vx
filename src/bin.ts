#!/usr/bin/env bun
import { run } from './cli.js'
import { UserError } from './util/errors.js'

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // For UserError (workspace not found, cycle, config invalid, ...) we
    // print the message only — the stack trace is noise the user can't
    // act on. For everything else (internal bugs, unexpected throws) we
    // print the full stack to aid debugging.
    if (err instanceof UserError) {
      process.stderr.write(`vzn: ${err.message}\n`)
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      process.stderr.write(`vzn: ${message}\n`)
    }
    process.exit(1)
  },
)
