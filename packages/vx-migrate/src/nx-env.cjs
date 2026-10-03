#!/usr/bin/env node
// `nx-env [--dotenv <file>]... [--envFile <file>] [--ready-when <string>]... -- <command> [args…]`
//
// A shell line with the `.env` files Nx gives the task it came from: what
// `nx()` and the migrator wrap an `nx:run-commands` or `nx:run-script` line
// in when the task has any (nx-dotenv.cjs has the rules). The command runs
// as `sh -c`, with whatever follows it appended quoted — exactly what vx
// appends to a line after `vx run … --` — so the line is the same one it
// would be unwrapped.
//
// `--ready-when`, repeated: a run-commands target's several `readyWhen`
// strings. Nx is ready once every one has appeared in the output, stdout
// or stderr; vx's `readyWhen` is one pattern matched per line. So the
// child's streams pass through unchanged, separately, and once all the
// strings have been seen this prints one line, READY, which is the task's
// `readyWhen`. (Nx's `isReady` marks at most one string per output chunk,
// so two arriving together in a last chunk never made it ready; here each
// counts.)
//
// Node and CommonJS for the reason `nx-exec` is: the loading is Nx's own,
// resolved from the working directory up to the workspace's `nx`.

'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const path = require('node:path')
const { loadTaskEnv } = require('./nx-dotenv.cjs')

// `--envFile`, Nx's own option name, and not `--env-file`: Node 22 takes
// `--env-file` from anywhere on its command line, the script's arguments
// included, and exits 9 when the file is missing.
const USAGE =
  'usage: nx-env [--dotenv <file>]... [--envFile <file>] [--ready-when <string>]... -- <command> [args…]'

/** The line printed once every `--ready-when` string has been seen. */
const READY = 'nx-env: ready'

/** vx's own quoting for an appended argument (runner.ts `shellQuote`). */
function shellQuote(arg) {
  if (arg === '') return "''"
  if (/^[A-Za-z0-9_\-.,/=:@%+]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}

function parseArgs(argv) {
  const out = { dotenv: [], envFile: undefined, readyWhen: [], command: undefined, args: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out.command = argv[i + 1]
      out.args = argv.slice(i + 2)
      break
    }
    if (a === '--help' || a === '-h') return { help: true }
    const value = argv[i + 1]
    if ((a === '--dotenv' || a === '--envFile' || a === '--ready-when') && value !== undefined) {
      if (a === '--dotenv') out.dotenv.push(value)
      else if (a === '--ready-when') out.readyWhen.push(value)
      else out.envFile = value
      i++
      continue
    }
    return { error: `unexpected ${JSON.stringify(a)}\n${USAGE}` }
  }
  if (out.command === undefined) return { error: `no command after --\n${USAGE}` }
  return out
}

/**
 * Runs `line` with the streams piped through, printing READY once every
 * string has been seen in them; resolves with the shell's exit.
 */
function runWatched(line, env, strings) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', line], { stdio: ['inherit', 'pipe', 'pipe'], env })
    const missing = new Set(strings)
    const longest = Math.max(...strings.map((s) => s.length))
    const watch = (stream, out) => {
      // A string split across two chunks is still seen: the tail carries over.
      let tail = ''
      stream.on('data', (chunk) => {
        out.write(chunk)
        if (missing.size === 0) return
        const text = tail + chunk.toString()
        for (const s of [...missing]) if (text.includes(s)) missing.delete(s)
        tail = text.slice(-longest)
        if (missing.size === 0) process.stdout.write(`${READY}\n`)
      })
    }
    watch(child.stdout, process.stdout)
    watch(child.stderr, process.stderr)
    child.on('error', (err) => {
      process.stderr.write(`nx-env: ${err.message}\n`)
      resolve(1)
    })
    child.on('close', (code, signal) => {
      if (signal) resolve(128 + (require('node:os').constants.signals[signal] ?? 2))
      else resolve(code ?? 1)
    })
  })
}

async function main(argv) {
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
  if (args.readyWhen.length > 0) return runWatched(line, env, args.readyWhen)
  const r = spawnSync('sh', ['-c', line], { stdio: 'inherit', env })
  if (r.error) {
    process.stderr.write(`nx-env: ${r.error.message}\n`)
    return 1
  }
  if (r.signal) return 128 + (require('node:os').constants.signals[r.signal] ?? 2)
  return r.status ?? 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`nx-env: ${err && err.message ? err.message : String(err)}\n`)
    process.exitCode = 1
  },
)
