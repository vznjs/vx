#!/usr/bin/env bun
// `vx-cloud` — the platform CLI. Dispatches the service subcommands
// (server / agent / dev) that left core in the core/cloud split. Core's own
// `vx` CLI no longer carries these.

import { UserError, VERSION } from '@vzn/vx'
import { serverCmd } from './server.js'
import { agentCmd } from './agent.js'
import { devCmd } from './dev.js'
import { connectCmd, disconnectCmd, envCmd } from './env.js'

function printHelp(): void {
  process.stdout.write(
    [
      'vx-cloud — the vx orchestrator service',
      '',
      'Usage:',
      '  vx-cloud server',
      '  vx-cloud connect <url> [--name <n>] [--token <t>] [--delegate] [--no-use] [--force]',
      '  vx-cloud env ls | use <name> | rm <name>',
      '  vx-cloud disconnect',
      '  vx-cloud agent --url <serve> [--token <t>] [--capacity <n>] [--session <s>] [--idle-timeout <ms>] [--label <l>]',
      '  vx-cloud dev [--port <n>]',
      '  vx-cloud help',
      '  vx-cloud version',
      '',
      'server        The self-hosted CI platform (accounts, orgs, RBAC, workspaces;',
      '              docs/design/cloud-platform-2026-07.md). One process, one port:',
      '              the dashboard SPA, the /v1/* JSON API, POST /v1/ingest, MCP at',
      '              POST /mcp, the vx-native artifact store at /v1/cache, and the',
      '              agent/dist channels. Identity lives in Postgres; artifact',
      '              bytes live in an S3-compatible bucket. Configuration is',
      '              env-driven and REQUIRED at boot (all missing vars are listed',
      '              at once):',
      '                DATABASE_URL                   postgres://…',
      '                VX_CLOUD_SECRET                >= 32 chars (session HMAC)',
      '                VX_CLOUD_BASE_URL              public origin',
      '                VX_CLOUD_S3_ENDPOINT/_BUCKET/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY',
      '              Optional: VX_CLOUD_PORT (4321), VX_CLOUD_RETENTION_DAYS (180),',
      '              VX_CLOUD_S3_REGION/_PREFIX/_PRESIGN_TTL, VX_CLOUD_OPEN_SIGNUP,',
      '              VX_CLOUD_OPEN_ORG_CREATE, VX_CLOUD_DATA_DIR.',
      '              The first registered account becomes the instance admin;',
      '              after that, joining requires an invite link.',
      'connect       Validate a server (health + identity + token) and persist it as',
      '              a named environment in the per-user environments file; every',
      '              `vx run` then pushes its summary there. --delegate opts the',
      '              environment into run delegation; --no-use skips activation.',
      'env           Manage environments: `ls` (named servers, with live',
      '              reachability), `use <name>`, `rm <name>`. Tokens are stored',
      '              0600 and never printed.',
      'disconnect    Clear the active environment (entries + tokens survive;',
      '              runs stop pushing until you connect again).',
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
    case 'server':
      return await serverCmd(rest)
    case 'serve':
      process.stderr.write(
        'vx-cloud: `serve` was removed — vx-cloud is a self-hosted platform now. Run\n' +
          '  vx-cloud server\n' +
          'with DATABASE_URL, VX_CLOUD_SECRET, VX_CLOUD_BASE_URL and the VX_CLOUD_S3_*\n' +
          'vars set (docker-compose deployment: packages/cloud/deploy/).\n',
      )
      return 1
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
