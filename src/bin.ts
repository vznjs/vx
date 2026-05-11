#!/usr/bin/env node
import { run } from './cli.js'

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`vzn: ${message}\n`)
    process.exit(1)
  },
)
