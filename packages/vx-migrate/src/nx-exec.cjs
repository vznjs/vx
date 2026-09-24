#!/usr/bin/env node
// `nx-exec <executor> --project <p> --target <t> [--configuration <c>] --options '<json>'
//   [--dotenv <file>]... [overrides…]`
//
// One Nx executor as one process, through Nx's own public `runExecutor`
// (design: docs/design/nx-unchanged-2026-09.md). The command line carries
// the executor and its options, so vx's key sees them and `vx show` prints
// what runs; the workspace's cached project graph only supplies the
// `ExecutorContext` executors read (project root, dependencies). The
// target in the in-memory graph is REPLACED by the command line, so what
// runs is what the command says, never what project.json says today.
//
// Node, not Bun, and CommonJS on purpose: the executor runs in this
// process, and executors are Node programs (`@nx/nx-<platform>` native
// binding, jest workers). `nx` resolves from the working directory — the
// project dir vx runs every task in — up to the workspace's node_modules.
// Deep `nx/src` imports over the `@nx/devkit` barrel: 50 ms less per
// task, and a workspace with only `nx` and custom executors has no devkit.

'use strict'

const { createRequire, enableCompileCache } = require('node:module')
const path = require('node:path')
const { loadTaskEnv } = require('./nx-dotenv.cjs')

// Nx's module graph is ~150 ms of every executed task; Node's on-disk
// compile cache (22.1+, a no-op below) takes ~30 of them back on the
// second task, under os.tmpdir() by default, with nothing in a key.
if (typeof enableCompileCache === 'function') {
  try {
    enableCompileCache()
  } catch {
    // A read-only temp dir just means no cache.
  }
}

const USAGE =
  "usage: nx-exec <executor> --project <name> --target <name> [--configuration <name>] [--options '<json>'] [--dotenv <file>]... [overrides…]"

/** The flags that are nx-exec's own, each taken once but `--dotenv`; everything else is Nx's. */
const OWN = new Set(['project', 'target', 'configuration', 'options', 'dotenv'])

/**
 * Parsed argv, or `{ error }` — a usage error is exit 2, before Nx is loaded.
 * Every token that is not the executor or the first of an own flag is an
 * OVERRIDE, kept verbatim for Nx to parse: what `vx run … -- --otp=123`
 * appends to the line is what `nx run p:t --otp=123` gives the executor,
 * where it used to be a usage error (nx#12165).
 */
function parseArgs(argv) {
  const out = {
    executor: undefined,
    project: undefined,
    target: undefined,
    configuration: undefined,
    options: {},
    dotenv: [],
    overrides: [],
  }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (!a.startsWith('--')) {
      if (out.executor === undefined) out.executor = a
      else out.overrides.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (!OWN.has(name) || seen.has(name)) {
      out.overrides.push(a)
      continue
    }
    if (name !== 'dotenv') seen.add(name)
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1)
    if (value === undefined) return { error: `--${name} needs a value\n${USAGE}` }
    if (name === 'dotenv') out.dotenv.push(value)
    else if (name === 'options') {
      try {
        out.options = JSON.parse(value)
      } catch (err) {
        return { error: `--options is not JSON: ${err.message}` }
      }
      if (typeof out.options !== 'object' || out.options === null || Array.isArray(out.options)) {
        return { error: '--options must be a JSON object' }
      }
    } else out[name] = value
  }
  if (out.executor === undefined) return { error: `expected one executor (got 0)\n${USAGE}` }
  if (!out.executor.includes(':')) {
    return { error: `executor must be <package>:<name>, got ${JSON.stringify(out.executor)}` }
  }
  for (const f of ['project', 'target']) {
    if (out[f] === undefined || out[f] === '') return { error: `--${f} is required\n${USAGE}` }
  }
  return out
}

/** Both shapes a graph file takes: Nx's cache (`{ nodes, … }`) and `nx graph --file` (`{ graph: { nodes, … } }`). */
function unwrapGraph(g) {
  const inner = g && typeof g === 'object' && g.graph && typeof g.graph === 'object' ? g.graph : g
  if (
    !inner ||
    typeof inner !== 'object' ||
    typeof inner.nodes !== 'object' ||
    inner.nodes === null
  ) {
    return null
  }
  if (inner.externalNodes === undefined) inner.externalNodes = {}
  if (inner.dependencies === undefined) inner.dependencies = {}
  return inner
}

/**
 * The cached graph, or a fresh one when the cache is missing or unreadable.
 * The daemon is never dialed: NX_DAEMON is off for this process before `nx`
 * loads, so the fallback computes in-process — slow, bounded, and it writes
 * Nx's cache for the next task.
 */
async function loadGraph(nx) {
  const pg = nx('nx/src/project-graph/project-graph')
  let graph = null
  try {
    graph = unwrapGraph(pg.readCachedProjectGraph())
  } catch {
    // No cache, or a shape the reader did not understand: compute below.
  }
  if (graph === null) graph = unwrapGraph(await pg.createProjectGraphAsync({ exitOnError: false }))
  if (graph === null) throw new Error('nx produced a project graph with no nodes')
  return { graph, pg }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.error) {
    process.stderr.write(`nx-exec: ${args.error}\n`)
    return 2
  }
  if (process.env.NX_DAEMON === undefined) process.env.NX_DAEMON = 'false'

  const req = createRequire(path.join(process.cwd(), 'package.json'))
  let nx
  try {
    req.resolve('nx/package.json')
    nx = (spec) => req(spec)
  } catch {
    process.stderr.write(
      `nx-exec: cannot resolve \`nx\` from ${process.cwd()} — is it installed in this workspace?\n`,
    )
    return 1
  }
  // Before anything reads the environment: the executor runs in this
  // process, so the task's `.env` files (nx-dotenv.cjs) are its env.
  loadTaskEnv(nx, process.env, args.dotenv, undefined)

  const { graph, pg } = await loadGraph(nx)
  const node = graph.nodes[args.project]
  if (node === undefined) {
    process.stderr.write(
      `nx-exec: no project ${JSON.stringify(args.project)} in the Nx project graph\n`,
    )
    return 1
  }
  const target = { executor: args.executor, options: args.options }
  // The options are already the configuration's, flattened by whoever wrote
  // the command; the name is passed so an executor reading
  // `context.configurationName` sees it, and Nx's merge finds it declared.
  if (args.configuration !== undefined) target.configurations = { [args.configuration]: {} }
  node.data = { ...node.data, targets: { ...node.data?.targets, [args.target]: target } }

  const { readNxJson } = nx('nx/src/config/nx-json')
  const { runExecutor } = nx('nx/src/command-line/run/run')
  const { workspaceRoot } = nx('nx/src/utils/workspace-root')
  const context = {
    root: workspaceRoot,
    cwd: process.cwd(),
    isVerbose: process.env.NX_VERBOSE_LOGGING === 'true',
    projectName: args.project,
    targetName: args.target,
    configurationName: args.configuration,
    projectGraph: graph,
    projectsConfigurations: pg.readProjectsConfigurationFromProjectGraph(graph),
    nxJsonConfiguration: readNxJson(workspaceRoot),
  }
  // An executor yields once per result and a server yields for as long as it
  // runs; the exit is the LAST result's, as `nx run` reports it.
  let ok = false
  const description = { project: args.project, target: args.target }
  if (args.configuration !== undefined) description.configuration = args.configuration
  // Parsed by Nx itself, as `nx run` parses what follows the target. Loaded
  // only when there is something to parse: the module pulls in git helpers.
  // `runExecutor` derives the unparsed list from the parsed overrides, so the
  // parser's own copy is dropped — kept, it was serialized back as a flag,
  // `--__overrides_unparsed__=--otp=123`, and handed to the executor. The
  // derived list puts positional words first, where `nx run` keeps them in
  // the order typed.
  let overrides = {}
  if (args.overrides.length > 0) {
    const { createOverrides } = nx('nx/src/utils/command-line-utils')
    const { __overrides_unparsed__: _raw, ...parsed } = createOverrides(args.overrides)
    overrides = parsed
  }
  for await (const result of await runExecutor(description, overrides, context)) {
    ok = result !== null && typeof result === 'object' && result.success === true
  }
  return ok ? 0 : 1
}

/**
 * Exit once both streams have drained. An executor may leave a worker pool
 * or a timer alive after its last result (Nx's own runner calls
 * `process.exit` for the same reason); exiting in the write callbacks is
 * what keeps a piped stdout whole on the platforms where pipes are async.
 */
function finish(code) {
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

main(process.argv.slice(2)).then(finish, (err) => {
  process.stderr.write(`nx-exec: ${err && err.stack ? err.stack : String(err)}\n`)
  finish(1)
})
