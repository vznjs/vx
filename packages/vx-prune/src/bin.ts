#!/usr/bin/env bun
// `bunx @vzn/vx-prune <project>` — the verb without a workspace file. A
// UserError is one line on stderr, anything else is a crash worth a stack.

import { isUserError } from '@vzn/vx'
import { pruneWorkspace } from './index.js'

try {
  process.exitCode = await pruneWorkspace(process.argv.slice(2))
} catch (err) {
  if (isUserError(err)) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  } else {
    throw err
  }
}
