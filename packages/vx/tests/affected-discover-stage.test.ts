// A run takes names and edges from the lock's `discoverStage`, so a record
// that moved there moved keys though no config did: `--affected` selects
// at least every task whose key changed.
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { lock } from './helpers/orchestrator.js'
import { dry } from './helpers/parity.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

// Its answer is `graph.json` at the root, as nx() answers from Nx's graph.
const GRAPH = pluginSource(
  'org/graph',
  `{ discover: (ctx) => JSON.parse(require('node:fs').readFileSync(
      require('node:path').join(ctx.workspaceRoot, 'graph.json'), 'utf8')) }`,
)

const build = `export default { tasks: { build: {
  exec: { command: 'true' }, dependsOn: ['^build'], inputs: { files: ['src/**'] },
} } }`

type Entry = { dir: string; name?: string; deps?: string[] }

async function workspace(graph: Entry[], extra: (root: string) => Promise<void> = async () => {}) {
  const root = await makeWorkspace({ prefix: 'vx-affected-discover-' })
  made.push(root)
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${GRAPH}] }\n`,
  )
  for (const name of ['a', 'b', 'other'])
    await addProject(root, name, { config: build, files: { 'src/x': '1\n' } })
  await extra(root)
  await Bun.write(path.join(root, 'graph.json'), JSON.stringify(graph))
  await lock(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  return root
}

async function commitGraph(root: string, graph: Entry[]): Promise<void> {
  await Bun.write(path.join(root, 'graph.json'), JSON.stringify(graph))
  await lock(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
}

const ids = async (root: string) =>
  (await dry(root, ['build', '--affected=HEAD~1'])).map((t) => t.id).sort()

it('an edge the discover stage adds selects the project that gained it', async () => {
  const root = await workspace([
    { dir: 'packages/a', name: 'a', deps: [] },
    { dir: 'packages/b', name: 'b', deps: [] },
  ])
  await commitGraph(root, [
    { dir: 'packages/a', name: 'a', deps: [] },
    { dir: 'packages/b', name: 'b', deps: ['packages/a'] },
  ])
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  // a#build runs as b's dependency; only b is affected.
  expect(tasks.map((t) => [t.id, t.affected ?? null])).toEqual([
    ['b#build', { kind: 'workspace', file: '.vx/projects.lock.json' }],
    ['a#build', null],
  ])
})

it('a project the discover stage renames is selected with its dependants', async () => {
  const root = await workspace([
    { dir: 'packages/a', name: 'a', deps: [] },
    { dir: 'packages/b', name: 'b', deps: ['packages/a'] },
  ])
  await commitGraph(root, [
    { dir: 'packages/a', name: 'alpha', deps: [] },
    { dir: 'packages/b', name: 'b', deps: ['packages/a'] },
  ])
  expect(await ids(root)).toEqual(['alpha#build', 'b#build'])
})

it('a deleted project the discover stage added selects its dependants', async () => {
  const graph = (gen: boolean): Entry[] => [
    { dir: 'packages/a', name: 'a', deps: [] },
    { dir: 'packages/b', name: 'b', deps: gen ? ['tools/gen'] : [] },
    ...(gen ? [{ dir: 'tools/gen', name: 'gen', deps: [] }] : []),
  ]
  const root = await workspace(graph(true), async (r) => {
    await mkdir(path.join(r, 'tools/gen'), { recursive: true })
    await Bun.write(path.join(r, 'tools/gen/x'), '1\n')
  })
  await rm(path.join(root, 'tools'), { recursive: true })
  await commitGraph(root, graph(false))
  expect(await ids(root)).toEqual(['b#build'])
})
