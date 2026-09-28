#!/usr/bin/env node
// `lage-worker <module> --package <name> --task <name> [--options '<json>'] [taskArgs…]`
//
// One lage worker target as one process. lage runs a `type: 'worker'`
// target by importing its module into a worker thread and calling the
// exported function with `{ target, weight, taskArgs, abortSignal }`
// (lage 2.17's WorkerRunner); this does the same in a process of its own,
// so the target is a shell command vx can run, key and cache. The command
// line carries the module and the options, so vx's key sees them.
//
// Node, not Bun, and CommonJS on purpose: workers are Node programs
// (swc's native binding, jest's worker pool), as nx-exec's executors are.

'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const USAGE =
  "usage: lage-worker <module> --package <name> --task <name> [--options '<json>'] [taskArgs…]"

/** Parsed argv, or `{ error }` (exit 2, before the module loads). */
function parseArgs(argv) {
  const out = {
    module: undefined,
    packageName: undefined,
    task: undefined,
    options: {},
    taskArgs: [],
  }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    const own = /^--(package|task|options)(?:=(.*))?$/.exec(a)
    if (own === null || seen.has(own[1])) {
      if (out.module === undefined && !a.startsWith('-')) out.module = a
      else out.taskArgs.push(a)
      continue
    }
    seen.add(own[1])
    const value = own[2] !== undefined ? own[2] : argv[++i]
    if (value === undefined) return { error: `--${own[1]} needs a value\n${USAGE}` }
    if (own[1] === 'package') out.packageName = value
    else if (own[1] === 'task') out.task = value
    else {
      try {
        out.options = JSON.parse(value)
      } catch (err) {
        return { error: `--options is not JSON: ${err.message}\n${USAGE}` }
      }
    }
  }
  if (out.module === undefined || out.task === undefined) return { error: USAGE }
  return out
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.error) {
    process.stderr.write(`lage-worker: ${args.error}\n`)
    return 2
  }
  const file = path.resolve(args.module)
  const mod = await import(pathToFileURL(file).toString())
  const cwd = process.cwd()
  const id = args.packageName === undefined ? `#${args.task}` : `${args.packageName}#${args.task}`
  const options = { ...args.options, worker: file }
  const target = {
    id,
    label: args.packageName === undefined ? id : `${args.packageName} - ${args.task}`,
    cwd,
    task: args.task,
    type: 'worker',
    packageName: args.packageName,
    depSpecs: [],
    dependencies: [],
    dependents: [],
    options,
    weight: 1,
    shouldRun: true,
  }
  if (typeof mod.shouldRun === 'function' && !(await mod.shouldRun(target))) return 0
  const run =
    typeof mod.run === 'function'
      ? mod.run
      : typeof mod.default === 'function'
        ? mod.default
        : typeof mod.default?.run === 'function'
          ? mod.default.run
          : mod
  if (typeof run !== 'function') {
    process.stderr.write(`lage-worker: ${args.module} exports no function\n`)
    return 1
  }
  // A first signal aborts the worker's own work; a second ends the process.
  const controller = new AbortController()
  let signals = 0
  const onSignal = (sig) => {
    signals++
    if (signals === 1) controller.abort()
    else process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  await run({
    target,
    weight: 1,
    taskArgs: [
      ...(Array.isArray(args.options.taskArgs) ? args.options.taskArgs : []),
      ...args.taskArgs,
    ],
    abortSignal: controller.signal,
  })
  return controller.signal.aborted ? 1 : 0
}

/** Exit once both streams have drained: a worker may leave a pool or a timer alive. */
function finish(code) {
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

main(process.argv.slice(2)).then(finish, (err) => {
  process.stderr.write(`lage-worker: ${err && err.stack ? err.stack : String(err)}\n`)
  finish(1)
})
