// A FAKE `nx` for the suites that must not install the real one: the four
// `nx/src` modules `nx-exec` requires, recording what the bin hands
// `runExecutor` into `<root>/record.json` and yielding the results the
// injected options ask for; and a `node_modules/.bin/nx` whose only verb
// is `graph --file=<path>` (it copies `<root>/graph.json` there and into
// Nx's own cache path, the side effect the real one has, and counts the
// call in `<root>/nx-calls`). Real Nx is `nx-exec-live.test.ts`.
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const NX_EXEC_BIN = path.resolve(import.meta.dir, '..', '..', 'src', 'nx-exec.cjs')

export async function fakeNx(root: string): Promise<void> {
  const nx = path.join(root, 'node_modules', 'nx')
  const src = path.join(nx, 'src')
  await mkdir(path.join(src, 'project-graph'), { recursive: true })
  await mkdir(path.join(src, 'config'), { recursive: true })
  await mkdir(path.join(src, 'command-line', 'run'), { recursive: true })
  await mkdir(path.join(src, 'utils'), { recursive: true })
  await writeFile(
    path.join(nx, 'package.json'),
    JSON.stringify({ name: 'nx', version: '0.0.0-fake', main: 'index.js' }),
  )
  await writeFile(path.join(nx, 'index.js'), 'module.exports = {}\n')
  await writeFile(
    path.join(src, 'utils', 'workspace-root.js'),
    `const path = require('node:path')
exports.workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..')
`,
  )
  await writeFile(
    path.join(src, 'config', 'nx-json.js'),
    `const fs = require('node:fs'); const path = require('node:path')
exports.readNxJson = (root) => JSON.parse(fs.readFileSync(path.join(root, 'nx.json'), 'utf8'))
`,
  )
  await writeFile(
    path.join(src, 'project-graph', 'project-graph.js'),
    `const fs = require('node:fs'); const path = require('node:path')
const { workspaceRoot } = require('../utils/workspace-root')
const cache = path.join(workspaceRoot, '.nx', 'workspace-data', 'project-graph.json')
exports.readCachedProjectGraph = () => {
  if (!fs.existsSync(cache)) throw new Error('[readCachedProjectGraph] ERROR: No cached ProjectGraph is available.')
  return JSON.parse(fs.readFileSync(cache, 'utf8'))
}
exports.createProjectGraphAsync = async () => {
  fs.writeFileSync(path.join(workspaceRoot, 'computed.marker'), String(process.env.NX_DAEMON))
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'fallback-graph.json'), 'utf8'))
}
exports.readProjectsConfigurationFromProjectGraph = (g) => ({
  version: 2,
  projects: Object.fromEntries(Object.entries(g.nodes).map(([k, v]) => [k, v.data])),
})
`,
  )
  await writeFile(
    path.join(src, 'command-line', 'run', 'run.js'),
    `const fs = require('node:fs'); const path = require('node:path')
exports.runExecutor = async (description, overrides, context) => {
  const node = context.projectGraph.nodes[description.project]
  const target = node.data.targets[description.target]
  fs.writeFileSync(path.join(context.root, 'record.json'), JSON.stringify({
    description, overrides, target,
    context: {
      root: context.root, cwd: context.cwd, projectName: context.projectName,
      targetName: context.targetName, configurationName: context.configurationName,
      nxJson: context.nxJsonConfiguration,
      projects: Object.keys(context.projectsConfigurations.projects),
      taskGraph: context.taskGraph === undefined ? 'absent' : 'present',
    },
    env: { NX_DAEMON: process.env.NX_DAEMON },
  }))
  if (typeof target.options.writeFile === 'string') {
    const file = path.resolve(context.cwd, target.options.writeFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, target.options.content ?? 'executor wrote this')
  }
  const results = target.options.results ?? [{ success: true }]
  return (async function* () { for (const r of results) yield r })()
}
`,
  )
}

/** `node_modules/.bin/nx` (graph export only) and `node_modules/.bin/nx-exec` (the real bin). */
export async function fakeNxCli(root: string): Promise<void> {
  const bin = path.join(root, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  const nx = path.join(bin, 'nx')
  await writeFile(
    nx,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(path.join(root, 'nx-calls'))}
case "$1 $2" in
  "graph --file="*)
    cp ${JSON.stringify(path.join(root, 'graph.json'))} "\${2#--file=}"
    mkdir -p ${JSON.stringify(path.join(root, '.nx', 'workspace-data'))}
    cp ${JSON.stringify(path.join(root, 'graph.json'))} ${JSON.stringify(path.join(root, '.nx', 'workspace-data', 'project-graph.json'))} ;;
  *) echo "fake nx: unsupported: $*" >&2; exit 1 ;;
esac
`,
  )
  await chmod(nx, 0o755)
  await symlink(NX_EXEC_BIN, path.join(bin, 'nx-exec'))
}

/** How many times the fake `nx` ran. */
export async function nxCalls(root: string): Promise<number> {
  const f = Bun.file(path.join(root, 'nx-calls'))
  return (await f.exists()) ? (await f.text()).trim().split('\n').length : 0
}
