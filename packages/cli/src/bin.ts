#!/usr/bin/env node
import { run } from './index.js'

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    process.stderr.write(`nxt: ${message}\n`)
    process.exit(1)
  },
)
