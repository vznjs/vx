// Item 811's sweep of nx/nx-map.ts: each row fails with one line of the
// mapper undone. Driven through mapNxWorkspace on a synthetic graph.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { GeneratedTask, ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph, type NxGraph } from '../src/nx/nx-map.js'

let root: string
const OPTS = { persistentTodo: 'PERSIST', cacheable: new Set<string>() }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-map-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string, scripts: Record<string, string> = {}): Promise<ProjectMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  const packageJson = { name, scripts }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  return { name, dir, packageJson: packageJson as never, configPath: null }
}

const node = (rootRel: string, targets: Record<string, unknown>, name?: string) => ({
  ...(name !== undefined ? { name } : {}),
  data: { root: rootRel, targets },
})

async function tasksOf(
  metas: ProjectMeta[],
  nodes: Record<string, unknown>,
  dependencies: unknown = {},
): Promise<Map<string, GeneratedTask>> {
  const m = await mapNxWorkspace(root, metas, { nodes, dependencies } as NxGraph, OPTS)
  return new Map(m.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t])))
}

describe('nx-map: what the sweep found unheld', () => {
  it('a graph file of `null` names the shape it wanted, not a TypeError', () => {
    expect(() => parseNxGraph('null', 'graph.json')).toThrow(
      'graph.json: unrecognized shape — expected { graph: { nodes, dependencies } } or { nodes, dependencies }',
    )
  })

  it('a node root with a trailing slash still finds its project', async () => {
    // Unmatched, the node would be synthesized as a project of its own:
    // same name, but its dir carries the slash.
    const a = await meta('a')
    const m = await mapNxWorkspace(
      root,
      [a],
      {
        nodes: { a: node('packages/a/', { lint: { command: 'eslint .' } }) },
        dependencies: {},
      } as NxGraph,
      OPTS,
    )
    expect(m.projects.map((p) => [p.name, p.dir])).toEqual([['a', a.dir]])
  })

  it('a root node with no discovered project takes its package.json name', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws-root' }))
    const t = await tasksOf([], { 'root-node': node('.', { fmt: { command: 'prettier .' } }) })
    expect([...t.keys()]).toEqual(['ws-root#fmt'])
  })

  it('a defaultConfiguration that names no configuration is ignored', async () => {
    const a = await meta('a')
    const t = await tasksOf([a], {
      a: node('packages/a', {
        build: {
          executor: '@acme/x:build',
          options: { mode: 'base' },
          defaultConfiguration: 'ghost',
          configurations: { prod: { mode: 'prod' } },
        },
      }),
    })
    expect([...t.keys()]).toEqual(['a#build', 'a#build:prod'])
    const command = (t.get('a#build')!.task!['exec'] as { command: string }).command
    expect(command).toContain(`'{"mode":"base"}'`)
    expect(command).not.toContain('--configuration')
  })

  it('a group whose every ^ edge held nothing keeps an empty dependsOn', async () => {
    const a = await meta('a')
    const t = await tasksOf([a], {
      a: node('packages/a', { all: { executor: 'nx:noop', dependsOn: ['^ghost'] } }),
    })
    expect(t.get('a#all')!.task).toEqual({ dependsOn: [] })
  })

  it('a cached continuous target says it runs uncached', async () => {
    const a = await meta('a')
    const t = await tasksOf([a], {
      a: node('packages/a', { dev: { command: 'vite', continuous: true, cache: true } }),
    })
    expect(t.get('a#dev')!.todos).toContain(
      'Nx caches this target, and vx never caches a persistent task — uncached here',
    )
  })

  it('a cached target with no inputs and no nx.json default reads the whole project', async () => {
    const a = await meta('a')
    const t = await tasksOf([a], {
      a: node('packages/a', { build: { command: 'tsc', cache: true } }),
    })
    const cache = t.get('a#build')!.task!['cache'] as { inputs: { files: string[] } }
    expect(cache.inputs.files).toEqual(['**/*'])
  })

  it('a plain `command` target is its shorthand for run-commands', async () => {
    const a = await meta('a')
    const t = await tasksOf([a], { a: node('packages/a', { lint: { command: 'eslint .' } }) })
    expect((t.get('a#lint')!.task!['exec'] as { command: string }).command).not.toContain(
      'TODO(vx-migrate)',
    )
  })

  it('envFile: an absolute path is kept, and none is loaded under NX_LOAD_DOT_ENV_FILES=false', async () => {
    const a = await meta('a')
    const target = {
      executor: 'nx:run-commands',
      options: { command: 'echo hi', envFile: '/etc/app.env' },
    }
    const on = await tasksOf([a], { a: node('packages/a', { go: target }) })
    expect((on.get('a#go')!.task!['exec'] as { command: string }).command).toContain(
      '--envFile /etc/app.env --',
    )
    const saved = process.env['NX_LOAD_DOT_ENV_FILES']
    process.env['NX_LOAD_DOT_ENV_FILES'] = 'false'
    try {
      const off = await tasksOf([a], { a: node('packages/a', { go: target }) })
      expect((off.get('a#go')!.task!['exec'] as { command: string }).command).not.toContain(
        '--envFile',
      )
    } finally {
      if (saved === undefined) delete process.env['NX_LOAD_DOT_ENV_FILES']
      else process.env['NX_LOAD_DOT_ENV_FILES'] = saved
    }
  })

  it('nx:run-script runs the script its `script` option names', async () => {
    const a = await meta('a', { 'build:lib': 'tsc -p lib' })
    const t = await tasksOf([a], {
      a: node('packages/a', {
        build: { executor: 'nx:run-script', options: { script: 'build:lib' } },
      }),
    })
    expect((t.get('a#build')!.task!['exec'] as { command: string }).command).toBe('tsc -p lib')
  })

  it('`{args.*}` in an executor’s options is reported', async () => {
    const a = await meta('a')
    const t = await tasksOf([a], {
      a: node('packages/a', { e2e: { executor: '@acme/x:e2e', options: { spec: '{args.spec}' } } }),
    })
    expect(t.get('a#e2e')!.todos).toContain(
      '`{args.*}` in the options: params forwarding is not supported — put the value in the option',
    )
  })

  it('implicit deps: one pair per target project, and past five the rest are counted', async () => {
    const metas = [await meta('a')]
    const nodes: Record<string, unknown> = { a: node('packages/a', { lint: { command: 'x' } }) }
    const edges: { source: string; target: string }[] = []
    for (const n of ['b', 'c', 'd', 'e', 'f', 'g']) {
      metas.push(await meta(n))
      nodes[n] = node(`packages/${n}`, { lint: { command: 'x' } })
      edges.push({ source: 'a', target: n }, { source: 'a', target: n })
    }
    const m = await mapNxWorkspace(
      root,
      metas,
      { nodes, dependencies: { a: edges } } as NxGraph,
      OPTS,
    )
    expect(m.notes).toEqual([
      '6 implicit Nx deps not representable (a → b, a → c, a → d, a → e, a → f and 1 more); review dependsOn',
    ])
  })
})
