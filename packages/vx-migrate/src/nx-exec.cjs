#!/usr/bin/env node
// `nx-exec <executor> --project <p> --target <t> [--configuration <c>] --options '<json>'`
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

const { createRequire } = require('node:module')
const path = require('node:path')

const USAGE =
  "usage: nx-exec <executor> --project <name> --target <name> [--configuration <name>] [--options '<json>']"

/** Parsed argv, or `{ error }` — a usage error is exit 2, before Nx is loaded. */
function parseArgs(argv) {
  const out = {
    executor: undefined,
    project: undefined,
    target: undefined,
    configuration: undefined,
    options: {},
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1)
    if (value === undefined) return { error: `--${name} needs a value\n${USAGE}` }
    if (name === 'options') {
      try {
        out.options = JSON.parse(value)
      } catch (err) {
        return { error: `--options is not JSON: ${err.message}` }
      }
      if (typeof out.options !== 'object' || out.options === null || Array.isArray(out.options)) {
        return { error: '--options must be a JSON object' }
      }
    } else if (name === 'project' || name === 'target' || name === 'configuration') {
      out[name] = value
    } else return { error: `unknown flag --${name}\n${USAGE}` }
  }
  if (positional.length !== 1) {
    return { error: `expected one executor (got ${positional.length})\n${USAGE}` }
  }
  out.executor = positional[0]
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
  for await (const result of await runExecutor(description, {}, context)) {
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
