// Item 811's sweep of nx/nx-map.ts: each row fails with one line of the
// mapper undone. Driven through mapNxWorkspace on a synthetic graph.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { GeneratedTask, ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph, readNxJsonFacts, type NxGraph } from '../src/nx/nx-map.js'

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

  // nx-examples: an e2e project's Nx edge to its app (implicitDependencies)
  // has no package.json entry, so vx's `^typecheck` did not reach the app:
  // nothing ordered it and the app's source edit left the e2e typecheck a
  // hit. It was a note, "not representable". Nx links each dependency that
  // has the target and walks THROUGH one that lacks it
  // (`processTasksForDependencies`). CONTROL: a dependency the manifest
  // already reaches (`listed`) is vx's `^` edge alone, and an `npm:` node is
  // no project.
  it('`^target` follows the Nx graph: explicit edges, through a project that lacks the target', async () => {
    const metas: ProjectMeta[] = []
    const nodes: Record<string, unknown> = {}
    const targets: Record<string, Record<string, unknown>> = {
      e2e: { typecheck: { command: 'tsc', dependsOn: ['^typecheck'] } },
      app: { typecheck: { command: 'tsc' } },
      bridge: { lint: { command: 'x' } },
      deep: { typecheck: { command: 'tsc' } },
      listed: { typecheck: { command: 'tsc' } },
    }
    for (const n of Object.keys(targets)) {
      const m = await meta(n)
      metas.push(
        n === 'e2e'
          ? { ...m, packageJson: { name: n, dependencies: { listed: 'workspace:*' } } as never }
          : m,
      )
      nodes[n] = node(`packages/${n}`, targets[n]!)
    }
    nodes['npm:react'] = { data: {} }
    const edge = (source: string, ...to: string[]) => to.map((target) => ({ source, target }))
    const m = await mapNxWorkspace(
      root,
      metas,
      {
        nodes,
        dependencies: {
          e2e: edge('e2e', 'app', 'bridge', 'listed', 'npm:react'),
          bridge: edge('bridge', 'deep'),
        },
      } as NxGraph,
      OPTS,
    )
    const e2e = m.projects.find((p) => p.name === 'e2e')!.tasks.find((t) => t.name === 'typecheck')!
    expect(e2e.task!['dependsOn']).toEqual(['^typecheck', 'app#typecheck', 'deep#typecheck'])
  })
})

// Only the raw nx.json was read: named inputs its `extends` base declared
// fell back to `{projectRoot}/**` with no word, and a `sharedGlobals` edit
// re-ran nothing (item 1050). Nx merges the base under nx.json, shallowly.
// The root project has no package to attach to under the plugin, and its
// `prep` still counted as declared: `^prep` stayed on b's task and core
// refused the whole run, "no project in the workspace declares prep"
// (item 1051). Under Nx it is simply no edge.
describe('a `^target` only an unattached project declares', () => {
  it('is dropped when the plugin names the attached projects, kept for the CLI', async () => {
    const b = await meta('b')
    const nodes = {
      ws: node('.', { prep: { command: 'p' } }),
      b: node('packages/b', { hello: { command: 'h', dependsOn: ['^prep'] } }),
    }
    const graph = { nodes, dependencies: {} } as NxGraph
    const hello = async (attached?: Set<string>) => {
      const m = await mapNxWorkspace(root, [b], graph, {
        ...OPTS,
        ...(attached === undefined ? {} : { attached }),
      })
      return m.projects.find((p) => p.name === 'b')!.tasks.find((t) => t.name === 'hello')!.task
    }
    expect((await hello(new Set(['b'])))?.['dependsOn']).toBeUndefined()
    // CONTROL: the CLI writes the root's config too, so the edge holds.
    expect((await hello())?.['dependsOn']).toEqual(['^prep'])
  })
})

describe('nx.json is read through its `extends` chain', () => {
  it('a base’s named inputs apply; nx.json’s own field replaces the base’s whole', async () => {
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(
      path.join(root, 'config', 'nx.root.json'),
      JSON.stringify({
        tasksRunnerOptions: { default: { options: { cacheableOperations: ['lint'] } } },
      }),
    )
    await writeFile(
      path.join(root, 'nx.base.json'),
      JSON.stringify({
        extends: './config/nx.root.json',
        namedInputs: {
          default: ['{projectRoot}/**/*', 'sharedGlobals'],
          sharedGlobals: ['{workspaceRoot}/global.cfg'],
        },
      }),
    )
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({ extends: './nx.base.json' }))
    const facts = await readNxJsonFacts(root)
    expect({ named: facts.namedInputs, cacheable: [...facts.cacheable] }).toEqual({
      named: {
        default: ['{projectRoot}/**/*', 'sharedGlobals'],
        sharedGlobals: ['{workspaceRoot}/global.cfg'],
      },
      cacheable: ['lint'],
    })
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ extends: './nx.base.json', namedInputs: { production: ['default'] } }),
    )
    expect((await readNxJsonFacts(root)).namedInputs).toEqual({ production: ['default'] })
  })
})

// Item 910: Nx hashes a `^name` input over the project graph's
// dependencies whether or not a task edge exists, and merges a project's
// own `namedInputs` over nx.json's. The mapper dropped `^` inputs as
// "folded through dependsOn" and read nx.json alone, so a `test` with
// `^production` and no `dependsOn` hit after a dependency's source changed.
// Each project now has an `nx-input:<name>` twin keyed on its own input,
// chained along the Nx graph's edges; a reader depends on its direct
// dependencies' twins.
describe('nx-map: `^` inputs fold over the project graph through twins', () => {
  const cached = (inputs?: unknown[]) => ({
    command: 'true',
    cache: true,
    ...(inputs === undefined ? {} : { inputs }),
  })
  const shape = (t: GeneratedTask | undefined) => ({
    dependsOn: t?.task?.['dependsOn'],
    inputs: (t?.task?.['cache'] as { inputs: unknown } | undefined)?.inputs,
    todos: t?.todos,
  })
  const twin = (dependsOn: string[] | undefined, inputs: Record<string, unknown>) => ({
    dependsOn,
    inputs,
    todos: [],
  })

  async function graph(
    appInputs?: unknown[],
    appNamed?: Record<string, unknown[]>,
    edges: Record<string, string[]> = { app: ['lib', 'npm:react'], lib: ['base'] },
    discovered = ['app', 'lib', 'base'],
  ) {
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ namedInputs: { production: ['default', '!{projectRoot}/**/*.spec.ts'] } }),
    )
    const metas = []
    for (const m of discovered) metas.push(await meta(m))
    return tasksOf(
      metas,
      {
        app: {
          data: {
            root: 'packages/app',
            ...(appNamed === undefined ? {} : { namedInputs: appNamed }),
            targets: { test: cached(appInputs) },
          },
        },
        lib: {
          data: {
            root: 'packages/lib',
            namedInputs: { production: ['{projectRoot}/src/**'] },
            // A node with targets is a project even undiscovered.
            ...(discovered.includes('lib') ? { targets: { build: { command: 'b' } } } : {}),
          },
        },
        base: { data: { root: 'packages/base' } },
        'npm:react': { data: {} },
      },
      Object.fromEntries(
        Object.entries(edges).map(([s, ts]) => [
          s,
          ts.map((t) => ({ source: s, target: t, type: 'static' })),
        ]),
      ),
    )
  }

  // Nx reads `^{projectRoot}/x` and `{ fileset, dependencies: true }` as
  // each dependency's fileset (nx-examples' inferred `typecheck` carries
  // both). The first was looked up as a named input (a todo, nothing
  // keyed), the second expanded as the project's OWN fileset: a
  // dependency's edit re-keyed no dependant.
  it.each([
    ['^{projectRoot}/tsconfig.lib.json', '{projectRoot}/tsconfig.lib.json', ['tsconfig.lib.json']],
    [
      { fileset: '{projectRoot}/**/*.d.ts', dependencies: true },
      '{projectRoot}/**/*.d.ts',
      ['**/*.d.ts'],
    ],
  ])('a dependency fileset %j keys on each dependency’s files', async (input, fileset, files) => {
    const t = await graph([input])
    const id = `nx-input:fileset-${Bun.hash.xxHash3(fileset).toString(16).padStart(16, '0')}`
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: [`lib#${id}`],
      inputs: { files: [] },
      todos: [],
    })
    expect(shape(t.get(`lib#${id}`))).toEqual(twin([`base#${id}`], { files }))
    expect(shape(t.get(`base#${id}`))).toEqual(twin(undefined, { files }))
    expect(t.get(`lib#${id}`)?.task?.['description']).toBe(
      `Nx fileset ${fileset} of this project and what it reaches`,
    )
  })

  it('`^production` with no dependsOn is the direct dependencies’ twins, chained', async () => {
    const t = await graph(['default', '^production'])
    expect([...t.keys()]).toEqual([
      'app#test',
      'app#nx-input:production',
      'lib#build',
      'lib#nx-input:production',
      'base#nx-input:production',
    ])
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: ['lib#nx-input:production'],
      inputs: { files: ['**/*'] },
      todos: [],
    })
    // The twin of a project with no targets exists too, and each twin
    // is its own project's input, not the dependant's.
    expect(shape(t.get('lib#nx-input:production'))).toEqual(
      twin(['base#nx-input:production'], { files: ['src/**'] }),
    )
    expect(shape(t.get('base#nx-input:production'))).toEqual(
      twin(undefined, { files: ['**/*', '!**/*.spec.ts'] }),
    )
    expect(t.get('base#nx-input:production')?.task?.['exec']).toEqual({ command: 'true' })
    expect(t.get('base#nx-input:production')?.task?.['cache']).toMatchObject({
      outputs: { files: [] },
    })
  })

  it('no `inputs` is Nx’s `default` and `^default`', async () => {
    const t = await graph()
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: ['lib#nx-input:default'],
      inputs: { files: ['**/*'] },
      todos: [],
    })
    expect(shape(t.get('lib#nx-input:default'))).toEqual(
      twin(['base#nx-input:default'], { files: ['**/*'] }),
    )
  })

  it('a project’s own named input wins over nx.json’s', async () => {
    const t = await graph(['production'], {
      production: ['default', '{workspaceRoot}/shared/app-config.json'],
    })
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: undefined,
      inputs: { files: ['**/*'], workspaceFiles: ['shared/app-config.json'] },
      todos: [],
    })
    expect([...t.keys()].filter((k) => k.includes('nx-input'))).toEqual([])
  })

  it('`{input, projects}` names projects, not the closure; a missing one is a todo', async () => {
    const t = await graph([{ input: 'production', projects: ['base', 'ghost'] }])
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: ['base#nx-input:production'],
      inputs: { files: [] },
      todos: ['input project "ghost" is not a graph node — map manually'],
    })
  })

  it('a project without the named input: its twin says so', async () => {
    const t = await graph(['^typecheck'])
    expect(t.get('app#test')?.todos).toEqual([])
    expect(t.get('lib#nx-input:typecheck')?.todos).toEqual([
      'named input "typecheck" not found for "lib" — declare its globs manually',
    ])
  })

  it('a node with no vx project is walked through: its files join, its deps’ twins are edges', async () => {
    const t = await graph(['^production'], undefined, undefined, ['app', 'base'])
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: ['base#nx-input:production'],
      inputs: { files: [], workspaceFiles: ['packages/lib/src/**'] },
      todos: [],
    })
  })

  it('a project cycle: each twin carries its peers’ files, and edges leave the cycle only', async () => {
    const t = await graph(['^production'], undefined, {
      app: ['lib'],
      lib: ['app', 'base'],
    })
    expect(shape(t.get('app#test'))).toEqual({
      dependsOn: ['lib#nx-input:production'],
      inputs: { files: [] },
      todos: [],
    })
    expect(shape(t.get('lib#nx-input:production'))).toEqual(
      twin(['base#nx-input:production'], {
        files: ['src/**'],
        workspaceFiles: ['packages/app/**/*', '!packages/app/**/*.spec.ts'],
      }),
    )
    expect(shape(t.get('app#nx-input:production'))).toEqual(
      twin(['base#nx-input:production'], {
        files: ['**/*', '!**/*.spec.ts'],
        workspaceFiles: ['packages/lib/src/**'],
      }),
    )
  })
})
