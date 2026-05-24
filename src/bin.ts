#!/usr/bin/env bun
import { runCli } from './cli/index.ts'

const exitCode = await runCli(process.argv.slice(2))
process.exit(exitCode)
