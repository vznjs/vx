#!/usr/bin/env node
// `nx-env [--dotenv <file>]... [--envFile <file>] -- <command> [args…]`
//
// A shell line with the `.env` files Nx gives the task it came from: what
// `nx()` and the migrator wrap an `nx:run-commands` or `nx:run-script` line
// in when the task has any (nx-dotenv.cjs has the rules). The command runs
// as `sh -c`, with whatever follows it appended quoted — exactly what vx
// appends to a line after `vx run … --` — so the line is the same one it
// would be unwrapped.
//
// Node and CommonJS for the reason `nx-exec` is: the loading is Nx's own,
// resolved from the working directory up to the workspace's `nx`.

'use strict'

const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const path = require('node:path')
const { loadTaskEnv } = require('./nx-dotenv.cjs')

// `--envFile`, Nx's own option name, and not `--env-file`: Node 22 takes
// `--env-file` from anywhere on its command line, the script's arguments
// included, and exits 9 when the file is missing.
const USAGE = 'usage: nx-env [--dotenv <file>]... [--envFile <file>] -- <command> [args…]'

/** vx's own quoting for an appended argument (runner.ts `shellQuote`). */
function shellQuote(arg) {
  if (arg === '') return "''"
  if (/^[A-Za-z0-9_\-.,/=:@%+]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}

function parseArgs(argv) {
  const out = { dotenv: [], envFile: undefined, command: undefined, args: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out.command = argv[i + 1]
      out.args = argv.slice(i + 2)
      break
    }
    if (a === '--help' || a === '-h') return { help: true }
    const value = argv[i + 1]
    if ((a === '--dotenv' || a === '--envFile') && value !== undefined) {
      if (a === '--dotenv') out.dotenv.push(value)
      else out.envFile = value
      i++
      continue
    }
    return { error: `unexpected ${JSON.stringify(a)}\n${USAGE}` }
  }
  if (out.command === undefined) return { error: `no command after --\n${USAGE}` }
  return out
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.error) {
    process.stderr.write(`nx-env: ${args.error}\n`)
    return 2
  }
  const req = createRequire(path.join(process.cwd(), 'package.json'))
  try {
    req.resolve('nx/package.json')
  } catch {
    process.stderr.write(
      `nx-env: cannot resolve \`nx\` from ${process.cwd()} — is it installed in this workspace?\n`,
    )
    return 1
  }
  const env = { ...process.env }
  try {
    loadTaskEnv((spec) => req(spec), env, args.dotenv, args.envFile)
  } catch (err) {
    process.stderr.write(`nx-env: ${err && err.message ? err.message : String(err)}\n`)
    return 1
  }
  const line = [args.command, ...args.args.map(shellQuote)].join(' ')
  // The task's process group gets vx's signals, the shell included; this
  // process waits for the shell and reports its end rather than dying first.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => {})
  const r = spawnSync('sh', ['-c', line], { stdio: 'inherit', env })
  if (r.error) {
    process.stderr.write(`nx-env: ${r.error.message}\n`)
    return 1
  }
  if (r.signal) return 128 + (require('node:os').constants.signals[r.signal] ?? 2)
  return r.status ?? 1
}

process.exitCode = main(process.argv.slice(2))
