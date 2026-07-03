#!/usr/bin/env bun
// `vx-cloud` — the orchestrator service CLI. Dispatches the service
// subcommands (serve / agent / dev) that left core in the core/cloud
// split. Core's own `vx` CLI no longer carries these.

import { UserError, VERSION } from '@vzn/vx'
import { serveCmd } from './serve.js'
import { agentCmd } from './agent.js'
import { devCmd } from './dev.js'
import { connectCmd, disconnectCmd, envCmd } from './env.js'

function printHelp(): void {
  process.stdout.write(
    [
      'vx-cloud — the vx orchestrator service',
      '',
      'Usage:',
      '  vx-cloud serve [--port <n>] [--host <h>] [--ingest-dir <d>] [--token <t>] [--name <n>] [--socket [path]] [--allow-origin <o>] [--ui] [--open]',
      '  vx-cloud connect <url> [--name <n>] [--token <t>] [--delegate] [--no-use] [--force]',
      '  vx-cloud env ls | use <name> | rm <name>',
      '  vx-cloud disconnect',
      '  vx-cloud agent --url <serve> [--token <t>] [--capacity <n>] [--session <s>] [--idle-timeout <ms>] [--label <l>]',
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
      '   --host <h>  TCP bind address (env: VX_CLOUD_HOST). Defaults to 127.0.0.1',
      '              (loopback) — a non-loopback bind (e.g. 0.0.0.0) REQUIRES a',
      '              token, since the run/agent channels execute arbitrary tasks.',
      '   --token <t>  Require `Authorization: Bearer <t>` on every request except',
      '              /health and /v1/meta (env: VX_CLOUD_TOKEN). No token → open',
      '              (loopback only). Cross-origin browser WS/SSE handshakes are',
      '              always refused unless allow-listed (CSWSH defense).',
      '   --pr-token <t>  The UNTRUSTED (fork-PR) bearer (env: VX_CLOUD_PR_TOKEN).',
      '              Its holder reads the trusted + untrusted cache scopes but',
      '              writes ONLY untrusted, so a fork PR warms off main’s cache',
      '              without being able to poison it. Safe to expose.',
      '   --allow-origin <o>  Extra browser origin permitted to open the WS/SSE',
      '              channels (repeatable; env: VX_CLOUD_ALLOW_ORIGIN, comma-sep) —',
      '              for a hosted dashboard served from a different origin.',
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
      'agent         Attach this machine (same repo, same commit, CLEAN tree) to a',
      '              serve session and execute assigned tasks via scoped cached runs.',
      '              Enable distribution on the submitting run with',
      '              VX_CLOUD_DISTRIBUTE=<n>. Exits 0 on clean drain / idle timeout',
      '              (task verdicts belong to the main job); 1 on refusal or a',
      '              dirty tree.',
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
    case 'agent':
      return await agentCmd(rest)
    case 'coordinator':
      process.stderr.write(
        'vx-cloud: `coordinator` was absorbed into `vx-cloud serve` — start a serve and\n' +
          'enable distribution on the submitting run with VX_CLOUD_DISTRIBUTE=<n>.\n',
      )
      return 1
    case 'worker':
      process.stderr.write(
        'vx-cloud: `worker` is now `vx-cloud agent` — run\n' +
          '  vx-cloud agent --url <serve-origin> [--token <t>] [--capacity <n>]\n',
      )
      return 1
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
