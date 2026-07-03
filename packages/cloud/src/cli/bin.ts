#!/usr/bin/env bun
// `vx-cloud` — the orchestrator service CLI. Dispatches the service
// subcommands (serve / coordinator / worker / dev) that left core in the
// core/cloud split. Core's own `vx` CLI no longer carries these.

import { UserError, VERSION } from '@vzn/vx'
import { serveCmd } from './serve.js'
import { coordinatorCmd } from './coordinator.js'
import { workerCmd } from './worker.js'
import { devCmd } from './dev.js'
import { connectCmd, disconnectCmd, envCmd } from './env.js'

function printHelp(): void {
  process.stdout.write(
    [
      'vx-cloud — the vx orchestrator service',
      '',
      'Usage:',
      '  vx-cloud serve [--port <n>] [--ingest-dir <d>] [--token <t>] [--name <n>] [--socket [path]] [--ui] [--open]',
      '  vx-cloud connect <url> [--name <n>] [--token <t>] [--delegate] [--no-use] [--force]',
      '  vx-cloud env ls | use <name> | rm <name>',
      '  vx-cloud disconnect',
      '  vx-cloud coordinator <tasks...> [--port <n>] [--host <h>] [--workers <n>]',
      '  vx-cloud worker --coordinator <coord-url> [--capacity <n>] [--label <l>]',
      '  vx-cloud dev [--port <n>]',
      '  vx-cloud help',
      '  vx-cloud version',
      '',
      'serve         Foreground Bun + SQLite + UI server — a standalone dashboard.',
      '              Serves the bundled dashboard at / (when embedded), the metrics',
      '              JSON API at /v1/*, SSE / NDJSON event streams, the push',
      '              endpoint POST /v1/ingest, an MCP endpoint for AI agents at',
      '              POST /mcp, and a Turbo-wire artifact store at /v8/artifacts',
      '              (point VX_REMOTE_CACHE_URL at the serve). The dashboard reads',
      '              ONLY this service’s own SQLite store (fed by the cloud()',
      '              plugin) — it never reads a workspace cache.db, so it can run',
      '              anywhere.',
      '   --port <n>  Port to bind. Defaults to VX_CLOUD_PORT, else 4321 — a',
      '              STABLE port, so the URL is the same across restarts (a busy',
      '              port errors rather than silently moving to a random one).',
      '   --ingest-dir <d>  Directory for the SQLite ingest store (persistence).',
      '   --token <t>  Require `Authorization: Bearer <t>` on every request except',
      '              /health and /v1/meta (env: VX_CLOUD_TOKEN). No token → open.',
      '   --name <n>  Server identity reported by /v1/meta + shown in the dashboard',
      '              badge (env: VX_CLOUD_NAME; defaults to the hostname).',
      '   --socket [path]  Also listen on a unix socket (env: VX_CLOUD_SOCKET;',
      '              default $XDG_RUNTIME_DIR/vx-cloud/serve.sock). Socket requests',
      '              bypass the token — the 0600 file permissions are the auth.',
      '   --ui       Require the bundled SPA (error if not built) + enable --open.',
      '              The UI is served automatically whenever it is embedded.',
      'connect       Validate a server (health + identity + token) and persist it as',
      '              a named environment in the per-user environments file; every',
      '              `vx run` then pushes its summary there. --delegate opts the',
      '              environment into run delegation; --no-use skips activation.',
      'env           Manage environments: `ls` (named servers + the auto-detected',
      '              `(local)` serve, with live reachability), `use <name>`,',
      '              `rm <name>`. Tokens are stored 0600 and never printed.',
      'disconnect    Clear the active environment (entries + tokens survive; the',
      '              local serve auto-detect becomes the effective fallback again).',
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
    case 'connect':
      return await connectCmd(rest)
    case 'env':
      return await envCmd(rest)
    case 'disconnect':
      return disconnectCmd(rest)
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
