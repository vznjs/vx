// Item 810's sweep of turbo/turbo-map.ts: each row fails with one line of
// the mapper undone. Driven through mapTurboWorkspace on a small tree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace, type TurboMappedTask } from '../src/turbo/turbo-map.js'

let root: string
const opts = { splice: (_k: string, v: readonly string[]) => v, persistentTodo: 'PERSIST' }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-map-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function map(
  turbo: unknown,
  pkgs: Record<string, { scripts: Record<string, unknown>; turbo?: unknown }>,
) {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo))
  const metas: ProjectMeta[] = []
  for (const [name, p] of Object.entries(pkgs)) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    if (p.turbo !== undefined)
      await writeFile(path.join(dir, 'turbo.json'), JSON.stringify(p.turbo))
    metas.push({ name, dir, packageJson: { name, scripts: p.scripts } as never, configPath: null })
  }
  return mapTurboWorkspace(root, metas, opts)
}

const taskOf = async (...args: Parameters<typeof map>): Promise<TurboMappedTask> =>
  (await map(...args)).projects[0]!.tasks[0]!

describe('turbo-map: what the sweep found unheld', () => {
  it('turbo 1’s `pipeline` is read like `tasks`', async () => {
    const t = await taskOf(
      { pipeline: { build: { outputs: ['dist/**'] } } },
      { a: { scripts: { build: 'b' } } },
    )
    expect(t.name).toBe('build')
  })

  it.each([
    ['', 'an empty string'],
    [null, 'null'],
    [['b'], 'an array'],
    [42, 'a number'],
  ])('a script of %j is reported as %s', async (value, words) => {
    const t = await taskOf({ tasks: { build: {} } }, { a: { scripts: { build: value } } })
    expect(t.todos).toEqual([
      `package.json script "build" is ${words}, not a non-empty command string — task skipped; write the command by hand`,
    ])
  })

  it('a root `pkg#task` key gives that package the task; a package overlay’s `#` key does not', async () => {
    const m = await map(
      { tasks: { 'a#gen': {} } },
      { a: { scripts: { gen: 'g', 'other#lint': 'l' }, turbo: { tasks: { 'other#lint': {} } } } },
    )
    expect(m.projects[0]!.tasks.map((t) => t.name)).toEqual(['gen'])
  })

  // Item 935: Turbo looks a package's task up as `pkg#task`, else `task`;
  // it never merges the two. The merge gave `a#build` the generic task's
  // `inputs`, so an edit outside them replayed a stale build.
  it('a root `pkg#task` replaces the generic task for its package; the others keep it', async () => {
    const m = await map(
      { tasks: { build: { inputs: ['src/**'], env: ['X'] }, 'a#build': { outputs: ['dist/**'] } } },
      { a: { scripts: { build: 'b' } }, b: { scripts: { build: 'b' } } },
    )
    const inputs = m.projects.map((p) => (p.tasks[0]!.task!['cache'] as { inputs: unknown }).inputs)
    expect(inputs).toEqual([{ files: ['**/*'] }, { files: ['src/**'], env: ['X'] }])
  })

  // Item 936: `inputs: []` is Turbo's default (every package file), and
  // an exclusion-only list narrows every file; the first keyed on nothing,
  // the second failed the whole run. CONTROL: a list with a positive entry
  // is left as it is.
  it.each([
    [[], ['**/*']],
    [['!**/*.md'], ['**/*', '!**/*.md']],
    [
      ['src/**', '!**/*.md'],
      ['src/**', '!**/*.md'],
    ],
  ])('inputs %j key on %j', async (inputs, files) => {
    const t = await taskOf({ tasks: { build: { inputs } } }, { a: { scripts: { build: 'b' } } })
    expect((t.task!['cache'] as { inputs: unknown }).inputs).toEqual({ files })
  })

  // Item 937: a wildcard in a global env list reached core, whose refusal
  // failed every task of the run; it is a note now, the rest still map.
  it('a global env wildcard is a note, and the explicit names still key and pass', async () => {
    const m = await map(
      {
        globalEnv: ['NEXT_PUBLIC_*', 'API'],
        globalPassThroughEnv: ['!SECRET', 'HOME_DIR'],
        tasks: { build: {} },
      },
      { a: { scripts: { build: 'b' } } },
    )
    const task = m.projects[0]!.tasks[0]!.task!
    expect({
      env: (task['cache'] as { inputs: { env?: unknown } }).inputs.env,
      pass: (task['exec'] as { env?: { passThrough?: unknown } }).env?.passThrough,
      notes: m.notes,
    }).toEqual({
      env: ['API'],
      pass: ['API', 'HOME_DIR'],
      notes: [
        'globalEnv "NEXT_PUBLIC_*": wildcards are not supported in vx env names — list explicit names',
        'globalPassThroughEnv "!SECRET": wildcards are not supported in vx env names — list explicit names',
      ],
    })
  })

  // Item 937: Turbo 1 hashes `globalDotEnv` into every task and a task's
  // `dotEnv` into that task; both were read as nothing, the task's with a
  // todo and the global's in silence.
  it('turbo 1’s `globalDotEnv` and a task `dotEnv` key the task', async () => {
    const t = await taskOf(
      {
        globalDotEnv: ['.env'],
        pipeline: { build: { inputs: ['src/**'], dotEnv: ['.env.local'] } },
      },
      { a: { scripts: { build: 'b' } } },
    )
    expect({ inputs: (t.task!['cache'] as { inputs: unknown }).inputs, todos: t.todos }).toEqual({
      inputs: { files: ['src/**', '.env.local'], workspaceFiles: ['.env'] },
      todos: [],
    })
  })

  // Item 938: Turbo 2.5+ reads `turbo.jsonc`. Only `turbo.json` was
  // looked for: a `.jsonc` root failed the run (ENOENT), and a package's
  // `.jsonc` overlay was skipped in silence, so its `inputs` keyed nothing.
  it('reads `turbo.jsonc` at the root and in a package', async () => {
    await writeFile(
      path.join(root, 'turbo.jsonc'),
      '{ // Turbo 2.5+\n "tasks": { "build": { "inputs": ["src/**"] } } }',
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'turbo.jsonc'),
      '{ "extends": ["//"], "tasks": { "build": { "inputs": ["$TURBO_EXTENDS$", "config.json"] } } }',
    )
    const m = await mapTurboWorkspace(
      root,
      [
        {
          name: 'a',
          dir,
          packageJson: { name: 'a', scripts: { build: 'b' } } as never,
          configPath: null,
        },
      ],
      opts,
    )
    const t = m.projects[0]!.tasks[0]!
    expect((t.task!['cache'] as { inputs: unknown }).inputs).toEqual({
      files: ['src/**', 'config.json'],
    })
  })

  // Item 939: a task Turbo defines but the package has no script for is a
  // no-op node that keeps its edges. Dropped whole, `test → codegen →
  // ^build` lost `^build`: `test` ran before its dependency's build and its
  // key never folded it. CONTROL: a dependency Turbo does not define at all
  // is still no edge, and a cycle through two script-less tasks ends.
  it('a script-less task in a chain passes its edges through', async () => {
    const m = await map(
      {
        tasks: {
          build: {},
          codegen: { dependsOn: ['^build', 'gen2'] },
          gen2: { dependsOn: ['codegen', 'lint'] },
          lint: {},
          test: { dependsOn: ['codegen', 'nowhere', '^build'] },
        },
      },
      {
        a: { scripts: { test: 't', lint: 'l' } },
        b: { scripts: { build: 'b' } },
      },
    )
    const test = m.projects[0]!.tasks.find((t) => t.name === 'test')!
    expect(test.task!['dependsOn']).toEqual(['^build', 'lint'])
  })

  // Item 940: Turbo 2 hashes and passes a framework's env prefix with
  // nothing in turbo.json; vx stripped the variables in silence. A note
  // names them. CONTROL: a package that runs no task is not named.
  it('a framework Turbo infers is named with its env prefix', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
    const metas: ProjectMeta[] = []
    for (const [name, deps, scripts] of [
      ['web', { dependencies: { next: '15' } }, { build: 'next build' }],
      ['site', { devDependencies: { vite: '6' } }, { build: 'vite build' }],
      ['idle', { dependencies: { next: '15' } }, {}],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      metas.push({ name, dir, packageJson: { name, scripts, ...deps } as never, configPath: null })
    }
    const m = await mapTurboWorkspace(root, metas, opts)
    expect(m.notes).toEqual([
      'Turbo infers next in web and hashes and passes NEXT_PUBLIC_* to its tasks; vx env names are explicit — list the ones they read in cache.inputs.env and exec.env.passThrough',
      'Turbo infers vite in site and hashes and passes VITE_* to its tasks; vx env names are explicit — list the ones they read in cache.inputs.env and exec.env.passThrough',
    ])
  })

  it('two tasks on one output path: the second runs uncached', async () => {
    const m = await map(
      { tasks: { build: { outputs: ['dist/**'] }, bundle: { outputs: ['dist/**'] } } },
      { a: { scripts: { build: 'b', bundle: 'u' } } },
    )
    expect(m.projects[0]!.tasks.map((t) => t.task!['cache'] !== undefined)).toEqual([true, false])
  })

  it('a persistent task never caches', async () => {
    const t = await taskOf(
      { tasks: { dev: { persistent: true, outputs: ['dist/**'] } } },
      { a: { scripts: { dev: 'vite' } } },
    )
    expect(t.task!['cache']).toBeUndefined()
  })

  it('a `pkg#task` edge to a package without that script is dropped with a todo', async () => {
    const m = await map(
      { tasks: { build: { dependsOn: ['b#gen'] } } },
      { a: { scripts: { build: 'b' } }, b: { scripts: { build: 'x' } } },
    )
    const a = m.projects[0]!.tasks[0]!
    expect(a.task!['dependsOn']).toBeUndefined()
    expect(a.todos).toEqual(['dependsOn "b#gen": b declares no gen script — edge dropped'])
  })

  it.each(['FOO_?', 'FOO_[AB]', '!FOO'])(
    'env and passThroughEnv %s are refused as wildcards',
    async (name) => {
      const t = await taskOf(
        { tasks: { build: { env: [name], passThroughEnv: [name] } } },
        { a: { scripts: { build: 'b' } } },
      )
      expect(t.todos).toHaveLength(2)
      expect(t.task!['exec']).toEqual({ command: 'b' })
    },
  )

  it('inputs: a negated $TURBO_ROOT$ path, one leaving the workspace, and $TURBO_ROOT$ mid-glob', async () => {
    const t = await taskOf(
      {
        tasks: {
          build: {
            inputs: ['src/**', '!$TURBO_ROOT$/secret.json', '../../../out.txt', 'a/$TURBO_ROOT$/x'],
          },
        },
      },
      { a: { scripts: { build: 'b' } } },
    )
    const inputs = (t.task!['cache'] as { inputs: { files: string[]; workspaceFiles?: string[] } })
      .inputs
    expect(inputs).toEqual({ files: ['src/**'], workspaceFiles: ['!secret.json'] })
    expect(t.todos).toEqual([
      'input "../../../out.txt": leaves the workspace — map manually',
      'input "a/$TURBO_ROOT$/x": $TURBO_ROOT$ only maps as a \'$TURBO_ROOT$/<path>\' prefix (→ cache.inputs.workspaceFiles) — map manually',
    ])
  })
})

// Item 906: Turbo 2.5+'s `$TURBO_EXTENDS$` in an overlay array keeps the
// inherited list and appends. Spread whole, the token was a literal glob and
// env name and the root's inputs, env and `^build` were gone: a source edit
// hit the cache and `lib#build` never ran first.
describe('turbo-map: a package overlay that extends an inherited list', () => {
  it('keeps the root’s entries and appends its own, for every array field', async () => {
    const t = await taskOf(
      {
        tasks: {
          build: {
            dependsOn: ['^build'],
            inputs: ['src/**'],
            env: ['MODE'],
            outputs: ['dist/**'],
          },
        },
      },
      {
        a: {
          scripts: { build: 'b' },
          turbo: {
            extends: ['//'],
            tasks: {
              build: {
                inputs: ['$TURBO_EXTENDS$', 'config.json'],
                env: ['$TURBO_EXTENDS$', 'EXTRA'],
                dependsOn: ['$TURBO_EXTENDS$'],
              },
            },
          },
        },
      },
    )
    const task = t.task as {
      dependsOn?: string[]
      cache?: { inputs?: { files?: string[]; env?: string[] } }
    }
    expect({
      dependsOn: task.dependsOn,
      files: task.cache?.inputs?.files,
      env: task.cache?.inputs?.env,
    }).toEqual({ dependsOn: ['^build'], files: ['src/**', 'config.json'], env: ['MODE', 'EXTRA'] })
  })

  it('CONTROL: an overlay array without the token replaces the inherited one', async () => {
    const t = await taskOf(
      { tasks: { build: { inputs: ['src/**'], outputs: ['dist/**'] } } },
      {
        a: {
          scripts: { build: 'b' },
          turbo: { extends: ['//'], tasks: { build: { inputs: ['lib/**'] } } },
        },
      },
    )
    const task = t.task as { cache?: { inputs?: { files?: string[] } } }
    expect(task.cache?.inputs?.files).toEqual(['lib/**'])
  })
})

// Item 909: Turbo 1 names an env dependency as `$NAME` in a task's
// `dependsOn` and in `globalDependencies`. The first was dropped and the
// second became a workspace glob matching nothing, so a changed var hit
// the cache with the old bytes.
describe('turbo-map: turbo 1 `$NAME` env dependencies', () => {
  it('re-key the task and reach it, from `dependsOn` and `globalDependencies`', async () => {
    const t = await taskOf(
      {
        globalDependencies: ['$GLOBAL_TOKEN', 'tsconfig.json'],
        pipeline: { build: { dependsOn: ['^build', '$API_URL'], outputs: ['dist/**'] } },
      },
      { a: { scripts: { build: 'b' } } },
    )
    const task = t.task as {
      dependsOn: string[]
      exec: { env: { passThrough: string[] } }
      cache: { inputs: { env: string[]; workspaceFiles: string[] } }
    }
    expect(task.dependsOn).toEqual(['^build'])
    expect(task.cache.inputs.env).toEqual(['GLOBAL_TOKEN', 'API_URL'])
    expect(task.cache.inputs.workspaceFiles).toEqual(['tsconfig.json'])
    expect(task.exec.env.passThrough).toEqual(['GLOBAL_TOKEN', 'API_URL'])
    expect(t.todos).toEqual([])
  })

  it('CONTROL: `$TURBO_ROOT$` and a `$` mid-entry are not env names', async () => {
    const t = await taskOf(
      { globalDependencies: ['$TURBO_ROOT$/x.json', 'a$B'], tasks: { build: {} } },
      { a: { scripts: { build: 'b' } } },
    )
    const inputs = (t.task!['cache'] as { inputs: { env?: string[] } } | undefined)?.inputs
    expect(inputs?.env).toBeUndefined()
  })
})

// Item 1031: Turbo's globs have character classes and extglobs, and a vx
// bracket is a literal, so `src/**/*.[jt]s` keyed on nothing and an edit
// replayed the old build; an output glob with a wildcard first segment
// reaches the sources, which vx cleans before every run, so `**/*.d.ts`
// deleted a hand-written `src/env.d.ts`.
describe('turbo-map: Turbo’s glob grammar', () => {
  const cacheOf = (t: TurboMappedTask) =>
    t.task!['cache'] as { inputs: { files: string[] }; outputs?: { files: string[] } } | undefined

  it('inputs translate classes and extglobs; one with no safe form widens to every file', async () => {
    const t = await taskOf(
      {
        tasks: {
          build: { inputs: ['src/**/*.[jt]s', '!**/*.[jt]s.map', 'lib/[a-z]/**'], outputs: [] },
        },
      },
      { a: { scripts: { build: 'b' } } },
    )
    expect({ files: cacheOf(t)!.inputs.files, todos: t.todos }).toEqual({
      files: ['src/**/*.{[jt],j,t}s', '!**/*.{j,t}s.map', '**/*'],
      todos: ['input "lib/[a-z]/**": glob syntax vx cannot take — map manually'],
    })
  })

  it('an output past its first segment translates; the first stays a literal', async () => {
    const t = await taskOf(
      { tasks: { build: { outputs: ['dist/**/*.[cm]js', '[locale]/**'] } } },
      { a: { scripts: { build: 'b' } } },
    )
    expect(cacheOf(t)!.outputs!.files).toEqual(['dist/**/*.{[cm],c,m}js', '[locale]/**'])
  })

  it.each([['**/*.d.ts'], ['*.tsbuildinfo']])(
    'an output whose first segment is a wildcard (%s) runs the task uncached',
    async (wild) => {
      const t = await taskOf(
        { tasks: { build: { outputs: ['dist/**', wild] } } },
        { a: { scripts: { build: 'b' } } },
      )
      expect({ cache: t.task!['cache'], todos: t.todos }).toEqual({
        cache: undefined,
        todos: [
          `output ${JSON.stringify(wild)}: a wildcard first segment reaches the sources, which vx cleans before every run — task runs uncached; declare the exact outputs in a vx.config to cache it`,
        ],
      })
    },
  )
})
