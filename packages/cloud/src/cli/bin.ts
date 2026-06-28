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
      '  vx-cloud serve [--port <n>] [--ingest-dir <d>] [--ui] [--open]',
      '  vx-cloud coordinator <tasks...> [--port <n>] [--host <h>] [--workers <n>]',
      '  vx-cloud worker --coordinator <coord-url> [--capacity <n>] [--label <l>]',
      '  vx-cloud dev [--port <n>]',
      '  vx-cloud help',
      '  vx-cloud version',
      '',
      'serve         Foreground Bun + SQLite + UI server — a standalone dashboard.',
      '              Serves the bundled dashboard at / (when embedded), the metrics',
      '              JSON API at /v1/*, SSE / NDJSON event streams, and the push',
      '              endpoint POST /v1/ingest. The dashboard reads ONLY this',
      '              service’s own SQLite store (fed by the cloud() plugin) — it',
      '              never reads a workspace cache.db, so it can run anywhere.',
      '   --port <n>  Port to bind. Defaults to VX_CLOUD_PORT, else 4321 — a',
      '              STABLE port, so the URL is the same across restarts (a busy',
      '              port errors rather than silently moving to a random one).',
      '   --ingest-dir <d>  Directory for the SQLite ingest store (persistence).',
      '   --ui       Require the bundled SPA (error if not built) + enable --open.',
      '              The UI is served automatically whenever it is embedded.',
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
