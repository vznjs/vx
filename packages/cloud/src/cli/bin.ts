#!/usr/bin/env bun
// `vx-cloud` — the orchestrator service CLI. Dispatches the service
// subcommands (serve / coordinator / worker / dev) that left core in the
// core/cloud split. Core's own `vx` CLI no longer carries these.

import { UserError, VERSION } from '@vzn/vx'
import { serveCmd } from './serve.js'
import { coordinatorCmd } from './coordinator.js'
import { workerCmd } from './worker.js'
import { devCmd } from './dev.js'

function printHelp(): void {
  process.stdout.write(
    [
      'vx-cloud — the vx orchestrator service',
      '',
      'Usage:',
      '  vx-cloud serve [--port <n>] [--ui] [--open]',
      '  vx-cloud coordinator <tasks...> [--port <n>] [--host <h>] [--workers <n>]',
      '  vx-cloud worker --coordinator <coord-url> [--capacity <n>] [--label <l>]',
      '  vx-cloud dev [--port <n>]',
      '  vx-cloud help',
      '  vx-cloud version',
      '',
      'serve         Foreground unified backend. While it runs, every `vx run` in',
      '              this workspace DELEGATES to it over a WebSocket. Also exposes',
      '              the metrics JSON API at /v1/* and SSE / NDJSON event streams.',
      '      --ui    Also serve the bundled dashboard SPA at /.',
      'coordinator   Per-run coordinator — holds graph + ready queue + fans tasks',
      '              to attached workers over WebSocket.',
      'worker        Stateless worker that pulls tasks from a coordinator.',
      'dev           Foreground devtools hub (needs the optional `devframe` package).',
      '',
    ].join('\n'),
  )
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp()
      return 0
    case '--version':
    case 'version':
      process.stdout.write(`vx-cloud ${VERSION}\n`)
      return 0
    case 'serve':
      return await serveCmd(rest)
    case 'coordinator':
      return await coordinatorCmd(rest)
    case 'worker':
      return await workerCmd(rest)
    case 'dev':
      return await devCmd(rest)
    default:
      process.stderr.write(`vx-cloud: unknown command: ${command}\n`)
      printHelp()
      return 1
  }
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof UserError) {
        process.stderr.write(`vx-cloud: ${err.message}\n`)
        process.exit(1)
      }
      throw err
    })
}
