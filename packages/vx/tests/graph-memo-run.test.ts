// The task graph memo (orchestrator/graph-memo.ts) as a run meets it. Each
// case plants a wrong graph under the token the next run would compute:
// a run that reads the memo plans the wrong edge, a run that builds plans
// the real one. With nothing changed the wrong edge shows, so the memo is
// read; after each edit the real one does, so the edit moved the token.

import { Database } from 'bun:sqlite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''

const A = `export default { tasks: {
  build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
  lint: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
} }\n`
const B = (dependsOn = "['a#build']"): string => `export default { tasks: {
  build: { dependsOn: ${dependsOn}, exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
  lint: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
} }\n`

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-graph-memo-run-' })
  for (const [name, config] of [
    ['a', A],
    ['b', B()],
  ] as const) {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
    await writeFile(path.join(dir, 'vx.config.mjs'), config)
    await writeFile(path.join(dir, 'src', 'x.txt'), name)
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const vx = (args: string[], env: Record<string, string> = {}, cwd = root): string => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
  if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
  return p.stdout.toString()
}

/** `b#build`'s deps as the plan of `args` has them. */
const depsOfB = (args: string[], env?: Record<string, string>, cwd?: string): string[] => {
  const plan = JSON.parse(vx(['run', ...args, '--dry=json'], env, cwd)) as {
    tasks: { id: string; deps: string[] }[]
  }
  return plan.tasks.find((t) => t.id === 'b#build')!.deps
}

/** Every remembered graph with `b#build` cut from its deps, under its own token. */
const plantWrongGraphs = (): number => {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    const graphs = (
      db.query('SELECT task_id, key FROM fold_memo').all() as { task_id: string; key: string }[]
    ).filter((r) => r.task_id.startsWith('\0graph\0'))
    for (const g of graphs) {
      const nodes = JSON.parse(g.key) as [string, string, number, number[]][]
      for (const n of nodes) if (n[0] === 'b' && n[1] === 'build') n[3] = []
      db.query('UPDATE fold_memo SET key = ? WHERE task_id = ?').run(
        JSON.stringify(nodes),
        g.task_id,
      )
    }
    return graphs.length
  } finally {
    db.close()
  }
}

const warm = (args = ['build', '--all']): void => {
  vx(['run', ...args])
  expect(plantWrongGraphs()).toBeGreaterThan(0)
  // Nothing moved: the planted graph is what the run reads.
  expect(depsOfB(args)).toEqual([])
}

it('nothing changed: the run reads the remembered graph', () => {
  warm()
})

it('a task config edit builds the graph again', async () => {
  warm()
  await writeFile(path.join(root, 'packages/b/vx.config.mjs'), B("['a#build', 'a#lint']"))
  expect(depsOfB(['build', '--all'])).toEqual(['a#build', 'a#lint'])
})

it('an env value a config reads builds the graph again', async () => {
  await writeFile(
    path.join(root, 'packages/b/vx.config.mjs'),
    B("['a#build', ...(process.env.GRAPH_MEMO_ENV ? ['a#lint'] : [])]"),
  )
  warm()
  expect(depsOfB(['build', '--all'], { GRAPH_MEMO_ENV: '1' })).toEqual(['a#build', 'a#lint'])
})

it('a workspace file edit builds the graph again', async () => {
  warm()
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([], '', '{ exclusiveOutputs: false }'),
  )
  expect(depsOfB(['build', '--all'])).toEqual(['a#build'])
})

it('a `project` plugin builds the graph every run', async () => {
  warm()
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/edges',
        `{ project(config, ctx) { if (ctx.name === 'b') config.tasks.build.dependsOn = ['a#build', 'a#lint'] } }`,
      ),
    ]),
  )
  expect(depsOfB(['build', '--all'])).toEqual(['a#build', 'a#lint'])
})

it('a `graph` plugin edits the graph after it is read', async () => {
  warm()
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/chain', `{ graph(nodes) { nodes.get('b#build').deps.push('a#lint') } }`),
    ]),
  )
  // A new plugin is a new workspace file: the graph is built, then edited.
  expect(depsOfB(['build', 'lint', '--all'])).toEqual(['a#build', 'a#lint'])
})

it('another selection is another graph', () => {
  warm()
  expect(depsOfB(['build', 'lint', '--all'])).toEqual(['a#build'])
  expect(depsOfB(['build'], {}, path.join(root, 'packages', 'b'))).toEqual(['a#build'])
})
