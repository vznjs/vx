#!/usr/bin/env bun
// `bunx @vzn/vx-migrate` — the adoption tool's own entry. Core's error
// classes are honoured the way `vx` honours them: a UserError is one line
// on stderr, anything else is a crash worth a stack.

import { isUserError } from '@vzn/vx'
import { migrateCmd } from './index.js'

try {
  process.exitCode = await migrateCmd(process.argv.slice(2))
} catch (err) {
  if (isUserError(err)) {
    process.stderr.write(`vx-migrate: ${err.message}\n`)
    process.exitCode = 1
  } else {
    throw err
  }
}
