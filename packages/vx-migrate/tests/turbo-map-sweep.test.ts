// Item 810's sweep of turbo/turbo-map.ts: each row fails with one line of
// the mapper undone. Driven through mapTurboWorkspace on a small tree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { UserError, type ProjectMeta } from '@vzn/vx'
import { DOTENV_PROBE, DOTENV_PROBE_TOP } from '../src/dotenv-probe.js'
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
  envNames?: readonly string[],
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
  return mapTurboWorkspace(root, metas, envNames === undefined ? opts : { ...opts, envNames })
}

const taskOf = async (...args: Parameters<typeof map>): Promise<TurboMappedTask> =>
  (await map(...args)).projects[0]!.tasks[0]!

describe('turbo-map: what the sweep found unheld', () => {
  // A bare ENOENT with a stack, until item 1043.
  it('a workspace with no Turbo config is refused as a user error that names the remedy', async () => {
    const err = await mapTurboWorkspace(root, [], opts).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UserError)
    expect((err as Error).message).toBe(
      `no turbo.json or turbo.jsonc at the workspace root (${root}): turbo() maps a Turbo repo's config — add one, or remove turbo() from vx.workspace.ts`,
    )
  })

  // Turbo 2.11.5's schema has it, and Turbo refuses a key it does not
  // know: it is a real key, and a todo for it was noise.
  it('a task’s `description` is the vx task’s description, with no todo', async () => {
    const t = await taskOf(
      { tasks: { build: { description: 'Compile the package', outputs: [] } } },
      { a: { scripts: { build: 'b' } } },
    )
    expect([t.task?.['description'], t.todos]).toEqual(['Compile the package', []])
  })

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
        globalPassThroughEnv: ['!SECRET', 'HOME_DIR', 'SECRET'],
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
      ],
    })
  })

  // A live mapping (turbo()) runs where the tasks will: Turbo matches a `*`
  // name against that environment, and so does the mapper, so every
  // Vercel template's `NEXT_PUBLIC_*` keys and passes what it names.
  it('a `*` env name expands over the live environment; a literal no variable has is dropped', async () => {
    const live = [
      'OTHER',
      'NEXT_PUBLIC_B',
      'NEXT_PUBLIC_VERCEL_URL',
      'NEXT_PUBLIC_A',
      'VITE_X',
      'TOKEN_1',
      'FOO_?',
    ]
    const m = await map(
      {
        globalEnv: ['VITE_*'],
        tasks: {
          build: {
            env: ['NEXT_PUBLIC_*', '!NEXT_PUBLIC_VERCEL_*', 'API', 'FOO_?', 'BAR_\\*'],
            passThroughEnv: ['TOKEN_*'],
          },
        },
      },
      { a: { scripts: { build: 'b' } } },
      live,
    )
    const t = m.projects[0]!.tasks[0]!
    expect({
      env: (t.task!['cache'] as { inputs: { env?: unknown } }).inputs.env,
      pass: (t.task!['exec'] as { env?: { passThrough?: unknown } }).env?.passThrough,
      todos: t.todos,
      notes: m.notes,
    }).toEqual({
      env: ['VITE_X', 'NEXT_PUBLIC_A', 'NEXT_PUBLIC_B', 'API'],
      pass: ['VITE_X', 'NEXT_PUBLIC_A', 'NEXT_PUBLIC_B', 'API', 'TOKEN_1'],
      todos: [],
      notes: [
        'env "FOO_?": Turbo reads this as the one variable "FOO_?" (only `*` is a wildcard), a name vx cannot key — dropped (1 task)',
      ],
    })
  })

  // Turbo's `wildcard_to_regex_pattern`: `*` is the one wildcard, `\*` a
  // literal `*`, a leading `\!` a literal `!`. unkey's `NEXT_PUBLIC_\*`
  // and `\!NEXT_PUBLIC_VERCEL_\*` name one variable each, which no
  // environment sets, and were 50 "wildcards are not supported" todos.
  it('an escaped `*` or `!` is a literal, as Turbo reads it', async () => {
    const turbo = {
      tasks: {
        build: { env: ['NEXT_PUBLIC_\\*', '\\!NEXT_PUBLIC_VERCEL_\\*', 'API', 'B_*', '!B_\\*'] },
      },
    }
    const pkgs = { a: { scripts: { build: 'b' } } }
    const read = async (live?: string[]) => {
      const m = await map(turbo, pkgs, live)
      const t = m.projects[0]!.tasks[0]!
      return {
        env: (t.task!['cache'] as { inputs: { env?: unknown } }).inputs.env,
        todos: [...t.todos, ...m.notes],
      }
    }
    // Reported once for the workspace, with the count of tasks naming it.
    const literal = (entry: string, name: string): string =>
      `env ${JSON.stringify(entry)}: Turbo reads this as the one variable ${JSON.stringify(name)} (only \`*\` is a wildcard), a name vx cannot key — dropped (1 task)`
    // Live: the escaped names are set nowhere, so Turbo hashes nothing for
    // them; the exclusion's \* is no wildcard, so B_1 stays.
    expect(await read(['B_1', 'NEXT_PUBLIC_A'])).toEqual({ env: ['API', 'B_1'], todos: [] })
    // One that is set is reported.
    expect(await read(['NEXT_PUBLIC_*'])).toEqual({
      env: ['API'],
      todos: [literal('NEXT_PUBLIC_\\*', 'NEXT_PUBLIC_*')],
    })
    expect(await read()).toEqual({
      env: ['API'],
      todos: [
        'env "B_*": wildcards are not supported in vx env names — list explicit names in cache.inputs.env + exec.env.passThrough',
        literal('NEXT_PUBLIC_\\*', 'NEXT_PUBLIC_*'),
        literal('\\!NEXT_PUBLIC_VERCEL_\\*', '!NEXT_PUBLIC_VERCEL_*'),
      ],
    })
  })

  // openstatus: `env: ["RESEND_API_KEY", "!NEXT_PUBLIC_VERCEL_URL",
  // "!NEXT_PUBLIC_VERCEL_GIT_*", …]`. An exclusion removes what the list
  // matched; vx matches nothing implicitly, so it is no wildcard todo.
  it('a `!` env entry removes the names it matches, with no todo', async () => {
    const m = await map(
      {
        tasks: {
          build: {
            env: ['API', '!GIT_*', 'GIT_SHA', '!URL', 'URL', 'URLS'],
            passThroughEnv: ['TOKEN', '!TOKEN', 'HOME_DIR'],
          },
        },
      },
      { a: { scripts: { build: 'b' } } },
    )
    const t = m.projects[0]!.tasks[0]!
    expect({
      env: (t.task!['cache'] as { inputs: { env?: unknown } }).inputs.env,
      pass: (t.task!['exec'] as { env?: { passThrough?: unknown } }).env?.passThrough,
      todos: t.todos,
    }).toEqual({ env: ['API', 'URLS'], pass: ['API', 'URLS', 'HOME_DIR'], todos: [] })
  })

  // Item 937: Turbo 1 hashes `globalDotEnv` into every task and a task's
  // `dotEnv` into that task; both were read as nothing, the task's with a
  // todo and the global's in silence.
  // Item 1032: both are `.env` files, gitignored as a rule, so they are
  // probed (per package, and at the root) rather than read as file globs.
  it('turbo 1’s `globalDotEnv` and a task `dotEnv` key the task', async () => {
    const t = await taskOf(
      {
        globalDotEnv: ['.env'],
        pipeline: { build: { inputs: ['src/**'], dotEnv: ['.env.local'] } },
      },
      { a: { scripts: { build: 'b' } } },
    )
    const inputs = (t.task!['cache'] as { inputs: Record<string, unknown> }).inputs
    const probe = (v: unknown) =>
      Array.isArray(v) && v.length === 1
        ? v[0] === DOTENV_PROBE
          ? 'walk'
          : v[0] === DOTENV_PROBE_TOP
            ? 'top'
            : v
        : v
    expect({
      files: inputs['files'],
      ws: inputs['workspaceFiles'],
      runtime: probe(inputs['runtime']),
      wsRuntime: probe(inputs['workspaceRuntime']),
      todos: t.todos,
    }).toEqual({
      files: ['src/**'],
      ws: undefined,
      runtime: 'top',
      wsRuntime: 'walk',
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
      'Turbo infers nextjs in web and hashes and passes NEXT_PUBLIC_*, NEXT_DEPLOYMENT_ID to its tasks; vx env names are explicit — list the ones they read in cache.inputs.env and exec.env.passThrough',
      'Turbo infers vite in site and hashes and passes VITE_* to its tasks; vx env names are explicit — list the ones they read in cache.inputs.env and exec.env.passThrough',
    ])
  })

  // Turbo's whole table, first match per package: a Next app on vite is
  // Next's alone, SvelteKit adds PUBLIC_*, `some` takes one dependency
  // (react-dev-utils), `all` needs each (solid-js without solid-start is
  // nothing), and a literal name (NEXT_DEPLOYMENT_ID) is keyed as named.
  it("a live mapping takes the first framework of Turbo's table", async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
    const metas: ProjectMeta[] = []
    for (const [name, deps] of [
      ['next', { dependencies: { next: '15', vite: '6' } }],
      ['kit', { devDependencies: { '@sveltejs/kit': '2', vite: '6' } }],
      ['cra', { devDependencies: { 'react-dev-utils': '12' } }],
      ['expo', { optionalDependencies: { expo: '52' } }],
      ['solid', { dependencies: { 'solid-js': '1' } }],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      const packageJson = { name, scripts: { build: 'b' }, ...deps }
      metas.push({ name, dir, packageJson: packageJson as never, configPath: null })
    }
    const live = ['NEXT_PUBLIC_A', 'VITE_X', 'PUBLIC_Y', 'REACT_APP_Z', 'EXPO_PUBLIC_W']
    const m = await mapTurboWorkspace(root, metas, { ...opts, envNames: live })
    const env = (p: number) =>
      (m.projects[p]!.tasks[0]!.task!['cache'] as { inputs: { env?: unknown } }).inputs.env
    expect([0, 1, 2, 3, 4].map(env)).toEqual([
      ['NEXT_PUBLIC_A', 'NEXT_DEPLOYMENT_ID'],
      ['VITE_X', 'PUBLIC_Y'],
      ['REACT_APP_Z'],
      ['EXPO_PUBLIC_W'],
      undefined,
    ])
  })

  // Turbo's task `tags` are labels kept out of its hash; a todo telling
  // the user to map them had nothing to map. CONTROL: an unknown key keeps
  // its todo.
  it('task tags map to nothing', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { tags: ['ci'] }, test: { tagz: ['ci'] } } }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const packageJson = { name: 'a', scripts: { build: 'b', test: 't' } }
    const m = await mapTurboWorkspace(
      root,
      [{ name: 'a', dir, packageJson: packageJson as never, configPath: null }],
      opts,
    )
    expect(m.projects[0]!.tasks.map((t) => [t.name, t.todos])).toEqual([
      ['build', []],
      ['test', ['turbo key "tagz" (["ci"]) has no vx equivalent — map it manually']],
    ])
  })

  // `interactive` has nothing to map: Turbo hands stdin only in its TUI and
  // vx hands no task the terminal. The todo says what a prompt meets (35
  // "map it manually" todos on uploadthing). `false` is Turbo's default.
  it('an interactive task says a prompt reads end of input', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: { push: { interactive: true, cache: false }, test: { interactive: false } },
      }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const packageJson = { name: 'a', scripts: { push: 'drizzle-kit push', test: 't' } }
    const m = await mapTurboWorkspace(
      root,
      [{ name: 'a', dir, packageJson: packageJson as never, configPath: null }],
      opts,
    )
    expect(m.projects[0]!.tasks.map((t) => [t.name, t.todos])).toEqual([
      [
        'push',
        [
          'turbo key "interactive": vx gives no task the terminal, so a prompt reads end of input — run a task that asks for input outside vx',
        ],
      ],
      ['test', []],
    ])
  })

  // A live mapping infers as Turbo does, and the task's own `!` entries
  // take names back (openstatus' `!NEXT_PUBLIC_VERCEL_URL`). CONTROL: a
  // package without the framework gets no prefix.
  // Vercel sets TURBO_CI_VENDOR_ENV_KEY=NEXT_PUBLIC_VERCEL_ so a deploy's
  // own variables (its commit SHA) stay out of the inferred set; kept in,
  // every deploy re-keyed every Next build. A task's own `env` still keys one.
  it('the CI vendor prefix is left out of framework inference only', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { env: ['NEXT_PUBLIC_VERCEL_ENV'] } } }),
    )
    const dir = path.join(root, 'packages', 'web')
    await mkdir(dir, { recursive: true })
    const packageJson = { name: 'web', scripts: { build: 'b' }, dependencies: { next: '15' } }
    const live = ['NEXT_PUBLIC_A', 'NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA', 'NEXT_PUBLIC_VERCEL_ENV']
    const env = async (vendorEnvPrefix?: string) => {
      const m = await mapTurboWorkspace(
        root,
        [{ name: 'web', dir, packageJson: packageJson as never, configPath: null }],
        { ...opts, envNames: live, ...(vendorEnvPrefix ? { vendorEnvPrefix } : {}) },
      )
      return (m.projects[0]!.tasks[0]!.task!['cache'] as { inputs: { env?: unknown } }).inputs.env
    }
    expect([await env('NEXT_PUBLIC_VERCEL_'), await env()]).toEqual([
      ['NEXT_PUBLIC_A', 'NEXT_DEPLOYMENT_ID', 'NEXT_PUBLIC_VERCEL_ENV'],
      [
        'NEXT_PUBLIC_A',
        'NEXT_PUBLIC_VERCEL_ENV',
        'NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA',
        'NEXT_DEPLOYMENT_ID',
      ],
    ])
  })

  it('a live mapping infers a framework env prefix, with no note', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { env: ['!NEXT_PUBLIC_VERCEL_URL', 'API'] } } }),
    )
    const metas: ProjectMeta[] = []
    for (const [name, deps] of [
      ['web', { dependencies: { next: '15' } }],
      ['lib', {}],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      const packageJson = { name, scripts: { build: 'b' }, ...deps }
      metas.push({ name, dir, packageJson: packageJson as never, configPath: null })
    }
    const live = ['NEXT_PUBLIC_VERCEL_URL', 'NEXT_PUBLIC_A', 'VITE_X']
    const m = await mapTurboWorkspace(root, metas, { ...opts, envNames: live })
    const env = (p: number) =>
      (m.projects[p]!.tasks[0]!.task!['cache'] as { inputs: { env?: unknown } }).inputs.env
    expect({ web: env(0), lib: env(1), notes: m.notes }).toEqual({
      web: ['NEXT_PUBLIC_A', 'NEXT_DEPLOYMENT_ID', 'API'],
      lib: ['API'],
      notes: [],
    })
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

  // highlight's `rrweb#build` names a submodule not checked out: "rrweb
  // declares no build script" sent the reader to a package.json that is not there.
  it('a `pkg#task` edge to no workspace package says the package is missing', async () => {
    const m = await map(
      { tasks: { build: { dependsOn: ['ghost#build'] } } },
      { a: { scripts: { build: 'b' } } },
    )
    const a = m.projects[0]!.tasks[0]!
    expect(a.task!['dependsOn']).toBeUndefined()
    expect(a.todos).toEqual([
      'dependsOn "ghost#build": no workspace package is named ghost — edge dropped',
    ])
  })

  it.each(['FOO_?', 'FOO_[AB]', '\\*'])(
    'env and passThroughEnv %s are refused as wildcards',
    async (name) => {
      const m = await map(
        { tasks: { build: { env: [name], passThroughEnv: [name] } } },
        { a: { scripts: { build: 'b' } } },
      )
      const t = m.projects[0]!.tasks[0]!
      expect([...t.todos, ...m.notes]).toHaveLength(2)
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
          build: { inputs: ['src/**/*.[jt]s', '!**/*.[jt]s.map', 'lib/[a-Z]/**'], outputs: [] },
        },
      },
      { a: { scripts: { build: 'b' } } },
    )
    expect({ files: cacheOf(t)!.inputs.files, todos: t.todos }).toEqual({
      files: ['src/**/*.{[jt],j,t}s', '!**/*.{j,t}s.map', '**/*'],
      todos: ['input "lib/[a-Z]/**": glob syntax vx cannot take — map manually'],
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

describe('turbo-map: a wildcard-first output of an untracked kind', () => {
  // n8n's tests output `*.xml` (junit), 143 tasks uncached by the
  // wildcard-first rule; one segment and a literal extension the package
  // tracks none of reaches no source.
  it.each([
    ['*.xml', true],
    ['./junit-*.xml', true],
    ['*.XML', true],
    ['*.d.ts', false],
    ['*.ts', false],
    ['*.{xml,json}', false],
    ['**/*.xml', false],
    ['*/report.xml', false],
    ['report*', false],
    ['**/dist/**', true],
    ['./**/build/**', true],
    ['**/src/**', false],
    ['**/dist/*.js', false],
    ['**/d*/**', false],
    ['**/**', false],
    // tldraw's `dist-*/**`: a first segment no tracked top-level entry matches.
    ['dist-*/**', true],
    ['{esm,cjs}/**', true],
    ['s*/**', false],
    ['*/**', false],
    ['package*/**', false],
    ['[x]*/**', false],
  ])('%s cached: %p', async (glob, cached) => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { test: { outputs: [glob] } } }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const mapped = await mapTurboWorkspace(
      root,
      [
        {
          name: 'a',
          dir,
          packageJson: { name: 'a', scripts: { test: 't' } } as never,
          configPath: null,
        },
      ],
      {
        ...opts,
        tracked: (rel) =>
          rel === 'packages/a'
            ? {
                exts: new Set(['ts', 'json']),
                dirs: new Set(['src']),
                tops: new Set(['src', 'package.json']),
              }
            : { exts: new Set(), dirs: new Set(), tops: new Set() },
      },
    )
    expect(mapped.projects[0]!.tasks[0]!.task!['cache'] !== undefined).toBe(cached)
  })

  it('without the tracked set every wildcard-first output runs uncached', async () => {
    const t = await taskOf(
      { tasks: { test: { outputs: ['*.xml'] } } },
      { a: { scripts: { test: 't' } } },
    )
    expect(t.task!['cache']).toBeUndefined()
  })
})

// Item 1032: `.env` inputs are gitignored as a rule; as file globs they
// keyed nothing (and a literal one failed the task), so they are probed.
describe('turbo-map: `.env` inputs', () => {
  const inputsOf = (t: TurboMappedTask) =>
    (t.task!['cache'] as { inputs: Record<string, unknown> }).inputs

  it.each([
    // A package's root-level globs take the one-shell probe; one below the
    // root, or the workspace's, takes the walk.
    [{ inputs: ['$TURBO_DEFAULT$', '.env*'] }, { files: ['**/*'], runtime: 'top' }],
    [{ inputs: ['src/**', '.env.local'] }, { files: ['src/**'], runtime: 'top' }],
    [{ dotEnv: ['.env.local'] }, { files: ['**/*'], runtime: 'top' }],
    [{ inputs: ['.env*', 'config/.env.local'] }, { files: [], runtime: 'walk' }],
    [{ inputs: ['$TURBO_ROOT$/.env'] }, { files: [], workspaceRuntime: 'walk' }],
  ])('%j keys %j', async (def, expected) => {
    const t = await taskOf({ tasks: { build: def } }, { a: { scripts: { build: 'b' } } })
    const got = inputsOf(t)
    const shape = Object.fromEntries(
      Object.entries(got).map(([k, v]) =>
        k === 'runtime' || k === 'workspaceRuntime'
          ? [
              k,
              (v as string[]).length !== 1
                ? v
                : (v as string[])[0] === DOTENV_PROBE
                  ? 'walk'
                  : (v as string[])[0] === DOTENV_PROBE_TOP
                    ? 'top'
                    : v,
            ]
          : [k, v],
      ),
    )
    expect(shape).toEqual(expected)
  })

  it('a root `.env` global is probed at the root, and leaves the file list', async () => {
    const m = await map(
      { globalDependencies: ['**/.env.*local', 'tsconfig.json'], tasks: { build: {} } },
      { a: { scripts: { build: 'b' } } },
    )
    const inputs = (m.projects[0]!.tasks[0]!.task!['cache'] as { inputs: Record<string, unknown> })
      .inputs
    expect({
      globals: m.globals.inputs,
      ws: inputs['workspaceFiles'],
      probed: (inputs['workspaceRuntime'] as string[] | undefined)?.length,
    }).toEqual({ globals: ['tsconfig.json'], ws: ['tsconfig.json'], probed: 1 })
  })
})

// Turbo 2.11's task `command` is authoritative over the script. Reported
// as "no vx equivalent" and dropped, it cost turborepo itself four tasks
// with no script and the edges to them.
describe('turbo-map: a task `command` (Turbo 2.11)', () => {
  const flags = { futureFlags: { experimentalTaskCommand: true } }
  const commandOf = (m: Awaited<ReturnType<typeof map>>, pkg: string, task: string) =>
    (
      m.projects.find((p) => p.name === pkg)!.tasks.find((t) => t.name === task)?.task?.['exec'] as
        | { command: string }
        | undefined
    )?.command

  it('an argv runs where the package has no script, and an edge to it holds', async () => {
    const m = await map(
      { ...flags, tasks: { build: {}, schema: { dependsOn: ['types#build'] } } },
      {
        types: { scripts: {}, turbo: { tasks: { build: { command: ['pnpm', 'exec', 'tsc'] } } } },
        docs: { scripts: { schema: 's' } },
      },
    )
    expect(commandOf(m, 'types', 'build')).toBe('pnpm exec tsc')
    const schema = m.projects[1]!.tasks.find((t) => t.name === 'schema')!
    expect(schema.task!['dependsOn']).toEqual(['types#build'])
    expect(schema.todos).toEqual([])
  })

  it('an argv replaces the script and folds none of its hooks; each word is quoted', async () => {
    const t = await taskOf(
      { ...flags, tasks: { build: { command: ['node', 'scripts/embed it.mjs', "it's"] } } },
      { a: { scripts: { prebuild: 'p', build: 'b', postbuild: 'q' } } },
    )
    expect((t.task!['exec'] as { command: string }).command).toBe(
      `node 'scripts/embed it.mjs' 'it'\\''s'`,
    )
    expect(t.todos).toEqual([])
  })

  it.each([[null], [[]]])(
    'a command of %j runs nothing where a script exists, and its edges pass through',
    async (command) => {
      const m = await map(
        {
          ...flags,
          tasks: {
            build: {},
            codegen: { command, dependsOn: ['^build'] },
            test: { dependsOn: ['codegen'] },
          },
        },
        { a: { scripts: { codegen: 'c', test: 't' } }, b: { scripts: { build: 'b' } } },
      )
      expect(m.projects[0]!.tasks.map((t) => t.name)).toEqual(['test'])
      expect(m.projects[0]!.tasks[0]!.task!['dependsOn']).toEqual(['^build'])
    },
  )

  it.each([
    [{ javascript: ['vitest'] }, 'vitest'],
    [{ typescript: ['jest'] }, 'jest'],
    [{ rust: ['cargo', 'test'] }, 't'],
  ])('a toolchain map %j runs %j in a JS package', async (command, expected) => {
    const t = await taskOf(
      { ...flags, tasks: { test: { command } } },
      { a: { scripts: { test: 't' } } },
    )
    expect((t.task!['exec'] as { command: string }).command).toBe(expected)
  })

  it('a command Turbo would refuse keeps the script, with a todo', async () => {
    const t = await taskOf(
      { ...flags, tasks: { test: { command: 'vitest' } } },
      {
        a: { scripts: { test: 't' } },
      },
    )
    expect((t.task!['exec'] as { command: string }).command).toBe('t')
    expect(t.todos).toEqual([
      'turbo key "command" ("vitest") is not an argv, null or a toolchain map of them — the script runs; write the command by hand',
    ])
  })
})

// read by Turbo 2.11, refused by 2.5: a package config extends another package's (`"extends":
// ["//", "mid"]`). Read as root-plus-own, `mid`'s tasks and fields were
// gone: `app#build` keyed without `mid/**` (a stale hit on an edit there),
// `app#check` was not emitted. Expected: `turbo run build check test
// --dry=json` on this fixture (Turbo 2.11.4).
describe('turbo-map: a package config that extends another package', () => {
  const fixture = {
    tasks: {
      build: { inputs: ['src/**'], outputs: ['dist/**'], env: ['A'] },
      test: { inputs: ['test/**'] },
      check: { dependsOn: ['build'] },
    },
  }
  const scripts = { build: 'b', check: 'c', test: 't' }
  const pkgs = {
    app: {
      scripts,
      turbo: { extends: ['//', 'mid'], tasks: { build: { env: ['$TURBO_EXTENDS$', 'C'] } } },
    },
    mid: {
      scripts,
      turbo: {
        extends: ['//', 'base'],
        tasks: { build: { inputs: ['$TURBO_EXTENDS$', 'mid/**'] }, test: { extends: false } },
      },
    },
    base: {
      scripts,
      turbo: {
        extends: ['//'],
        tasks: {
          build: { outputs: ['$TURBO_EXTENDS$', 'out/**'], env: ['B'] },
          check: { extends: false, inputs: ['check/**'] },
        },
      },
    },
    other: { scripts },
  }
  const summary = (t: TurboMappedTask) => {
    const task = t.task as {
      dependsOn?: string[]
      cache?: { inputs?: { files?: string[]; env?: string[] }; outputs?: { files?: string[] } }
    }
    return [
      t.name,
      task.cache?.inputs?.files ?? [],
      task.cache?.outputs?.files ?? [],
      task.cache?.inputs?.env ?? [],
      task.dependsOn ?? [],
    ]
  }

  it('folds every file of the chain, root first, as Turbo does', async () => {
    const m = await map(fixture, pkgs)
    const got = Object.fromEntries(
      m.projects.map((p) => [
        p.name,
        p.tasks.map(summary).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
      ]),
    )
    expect(got).toEqual({
      app: [
        ['build', ['src/**', 'mid/**'], ['dist/**', 'out/**'], ['B', 'C'], []],
        ['check', ['check/**'], [], [], []],
        ['test', ['**/*'], [], [], []],
      ],
      mid: [
        ['build', ['src/**', 'mid/**'], ['dist/**', 'out/**'], ['B'], []],
        ['check', ['check/**'], [], [], []],
      ],
      base: [
        ['build', ['src/**'], ['dist/**', 'out/**'], ['B'], []],
        ['check', ['check/**'], [], [], []],
        ['test', ['test/**'], [], [], []],
      ],
      other: [
        ['build', ['src/**'], ['dist/**'], ['A'], []],
        ['check', ['**/*'], [], [], ['build']],
        ['test', ['test/**'], [], [], []],
      ],
    })
  })

  it('refuses a parent with no turbo.json, and a cycle, as Turbo does', async () => {
    const refusal = (turbo: unknown, more: Record<string, unknown> = {}) =>
      map(fixture, { app: { scripts, turbo }, ...more } as never).then(
        () => '(mapped)',
        (e: Error) => `${e instanceof UserError} ${e.message}`,
      )
    expect([
      await refusal({ extends: ['//', 'nowhere'] }),
      await refusal(
        { extends: ['//', 'loop'] },
        { loop: { scripts, turbo: { extends: ['//', 'app'] } } },
      ),
      await refusal({ extends: ['//'] }),
    ]).toEqual([
      'true turbo.json of app extends nowhere, which has no turbo.json',
      'true turbo.json extends form a cycle: app → loop → app',
      '(mapped)',
    ])
  })
})

// Turbo 2.11's `futureFlags.globalConfiguration` moves the global lists
// under `global`. Unread, a global file's edit and a global env var keyed
// nothing: every task a stale hit. `global` replaces the top-level fields,
// as Turbo's `resolve_global_config` does.
describe('turbo-map: the `global` block', () => {
  it('maps global inputs, env and passThroughEnv, and replaces the top-level lists', async () => {
    const m = await map(
      {
        futureFlags: { globalConfiguration: true },
        globalEnv: ['OLD'],
        global: { inputs: ['tsconfig.base.json'], env: ['GLOBAL_V'], passThroughEnv: ['PT'] },
        tasks: { build: {} },
      },
      { a: { scripts: { build: 'b' } } },
    )
    expect(m.globals).toEqual({ inputs: ['tsconfig.base.json'], env: ['GLOBAL_V'], pass: ['PT'] })
  })
})

// Turbo 2.11's structured inputs: `{ mode, globs, withDefaults }` entries.
// Read as strings, an object crashed the plugin (`i.startsWith is not a
// function`) and the whole run failed.
describe('turbo-map: structured inputs', () => {
  it('maps startup and jit globs, withDefaults as every file; dependencyOutputs adds none', async () => {
    const files = async (inputs: unknown[]) => {
      const t = await taskOf({ tasks: { build: { inputs } } }, { a: { scripts: { build: 'b' } } })
      return (t.task as { cache?: { inputs?: { files?: string[] } } }).cache?.inputs?.files
    }
    expect([
      await files([
        { mode: 'startup', globs: ['src/**'] },
        { mode: 'jit', globs: ['gen/**'] },
        { mode: 'dependencyOutputs' },
      ]),
      await files([{ mode: 'startup', withDefaults: true, globs: ['!docs/**'] }]),
      await files([{ mode: 'jit', withDefaults: true, globs: ['gen/**'] }]),
      await files([{ mode: 'dependencyOutputs' }]),
      await files(['src/**']),
    ]).toEqual([
      ['src/**', 'gen/**'],
      ['**/*', '!docs/**'],
      ['**/*', 'gen/**'],
      ['**/*'],
      ['src/**'],
    ])
  })
})

// The G-13 sweep's survivors: a package that extends two packages which
// both extend the root (a diamond), an opt-out in the first parent, and
// two `extends: false` on one chain. Expected: `turbo run build test
// check --dry=json` on this fixture (Turbo 2.11.4).
describe('turbo-map: an extends diamond', () => {
  it("reads the root once, takes the first parent's opt-out and the nearest fresh definition", async () => {
    const scripts = { build: 'b', test: 't', check: 'c' }
    const m = await map(
      { tasks: { build: { inputs: ['src/**'] }, check: { inputs: ['root-check/**'] } } },
      {
        p: { scripts, turbo: { extends: ['//', 'a', 'b'], tasks: {} } },
        a: {
          scripts,
          turbo: {
            extends: ['//', 'c'],
            tasks: {
              build: { inputs: ['$TURBO_EXTENDS$', 'a/**'] },
              test: { extends: false },
              check: { extends: false, inputs: ['a-check/**'] },
            },
          },
        },
        b: {
          scripts,
          turbo: {
            extends: ['//'],
            tasks: {
              build: { inputs: ['$TURBO_EXTENDS$', 'b/**'] },
              test: { inputs: ['b-test/**'] },
              check: { extends: false, outputs: ['b-out/**'] },
            },
          },
        },
        c: { scripts, turbo: { extends: ['//'], tasks: { test: { inputs: ['c-test/**'] } } } },
        // Turbo refuses an empty `extends`; read as the root's.
        e: { scripts, turbo: { extends: [], tasks: {} } },
      },
    )
    const got = Object.fromEntries(
      m.projects.flatMap((p) =>
        p.tasks.map((t) => [
          `${p.name}#${t.name}`,
          (t.task as { cache?: { inputs?: { files?: string[] } } }).cache?.inputs?.files,
        ]),
      ),
    )
    expect(got).toEqual({
      'a#build': ['src/**', 'a/**'],
      'a#check': ['a-check/**'],
      'b#build': ['src/**', 'b/**'],
      'b#check': ['**/*'],
      'b#test': ['b-test/**'],
      'c#build': ['src/**'],
      'c#check': ['root-check/**'],
      'c#test': ['c-test/**'],
      'e#build': ['src/**'],
      'e#check': ['root-check/**'],
      'p#build': ['src/**', 'b/**'],
      'p#check': ['**/*'],
    })
  })
})

// A loose-mode repo's tasks read variables they never declare; vx's env is
// isolated, so they ran without them and nothing said so.
describe('turbo-map: envMode "loose"', () => {
  it('is a note, top-level or under `global`; strict and absent are not', async () => {
    const loose = async (cfg: Record<string, unknown>) =>
      (
        await map({ ...cfg, tasks: { build: {} } }, { a: { scripts: { build: 'b' } } })
      ).notes.filter((n) => n.startsWith('envMode')).length
    expect([
      await loose({ envMode: 'loose' }),
      await loose({ global: { envMode: 'loose' } }),
      await loose({ envMode: 'strict' }),
      await loose({}),
    ]).toEqual([1, 1, 0, 0])
  })

  // TURBO_ENV_MODE sits above turbo.json in Turbo; a CI's loose mode said nothing.
  it('TURBO_ENV_MODE, passed as envMode, wins over turbo.json', async () => {
    const loose = async (cfg: Record<string, unknown>, envMode: string) => {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ ...cfg, tasks: {} }))
      const m = await mapTurboWorkspace(root, [], { ...opts, envMode })
      return m.notes.filter((n) => n.startsWith('envMode')).length
    }
    expect([
      await loose({}, 'loose'),
      await loose({ envMode: 'loose' }, 'strict'),
      await loose({ envMode: 'loose' }, ''),
    ]).toEqual([1, 0, 1])
  })
})

// Turbo 1's default env mode, "infer", runs a task loose unless a
// pass-through list applies (1.13.4 on dub and trigger.dev: every task
// loose), so a `pipeline` repo's tasks read variables nobody declared and
// vx passed none of them, saying nothing.
describe("turbo-map: Turbo 1's inferred loose mode", () => {
  it('names the tasks no pass-through list covers; a global list or Turbo 2 are strict', async () => {
    const notes = async (cfg: Record<string, unknown>, envMode = '') => {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(cfg))
      const m = await mapTurboWorkspace(root, [], { ...opts, envMode })
      return m.notes.filter((n) => n.includes('loose'))
    }
    const pipeline = { build: {}, test: { passThroughEnv: [] }, lint: {} }
    expect(await notes({ pipeline })).toEqual([
      'Turbo 1 runs build, lint in loose env mode (no passThroughEnv, so its "infer" mode ' +
        'passes every environment variable); vx passes only the declared ones — list what each ' +
        'reads in exec.env.passThrough (or cache.inputs.env)',
    ])
    expect([
      await notes({ pipeline, globalPassThroughEnv: [] }),
      await notes({ pipeline: { test: { passThroughEnv: ['X'] } } }),
      await notes({ tasks: pipeline }),
      await notes({ pipeline }, 'strict'),
    ]).toEqual([[], [], [], []])
  })
})

describe('turbo-map: a field of the wrong type is refused by name (L-15)', () => {
  // Fuzzed: `"dependsOn": true` printed `TypeError: true is not iterable`
  // with its stack from `bunx @vzn/vx-migrate`; fifteen such shapes each
  // reached a mapper loop as a TypeError.
  const refusal = (turbo: unknown, pkg?: unknown) =>
    map(turbo, {
      web: { scripts: { build: 'tsc' }, ...(pkg !== undefined ? { turbo: pkg } : {}) },
    }).then(
      () => 'mapped',
      (e: unknown) => (e instanceof UserError ? e.message : `NOT A UserError: ${String(e)}`),
    )

  it('names the file and the field', async () => {
    const cases: Array<[unknown, unknown?]> = [
      [{ tasks: { build: { dependsOn: true } } }],
      [{ globalDependencies: 1, tasks: {} }],
      [{ tasks: { build: { inputs: null } } }],
      [{ tasks: [] }],
      [{ tasks: { build: { cache: 'no' } } }],
      [{ tasks: { build: {} } }, { extends: ['//'], tasks: { build: { outputs: [null] } } }],
      [[]],
    ]
    const got: string[] = []
    for (const [turbo, pkg] of cases) got.push(await refusal(turbo, pkg))
    expect(got).toEqual([
      'turbo.json: tasks."build".dependsOn must be an array of strings',
      'turbo.json: globalDependencies must be an array of strings',
      'turbo.json: tasks."build".inputs must be an array of globs',
      'turbo.json: tasks must be an object of tasks',
      'turbo.json: tasks."build".cache must be true or false',
      'packages/web/turbo.json: tasks."build".outputs must be an array of strings',
      'turbo.json: the file must be a JSON object',
    ])
  })

  it('CONTROL: the same fields of the right type map', async () => {
    expect(
      await refusal(
        {
          globalDependencies: ['a'],
          tasks: { build: { dependsOn: ['^build'], inputs: [], cache: true } },
        },
        { extends: ['//'], tasks: { build: { outputs: ['dist/**'] } } },
      ),
    ).toBe('mapped')
  })
})

describe('turbo-map: `!` outputs take paths back (A-44)', () => {
  const outputsOf = async (outputs: string[]) =>
    (
      (await taskOf({ tasks: { build: { outputs } } }, { a: { scripts: { build: 'b' } } })).task!
        .cache as { outputs: unknown }
    ).outputs

  it('a negation rides beside its positives, at the package or the root', async () => {
    expect(
      await outputsOf([
        'dist/**',
        '!dist/**/*.map',
        '$TURBO_ROOT$/out/**',
        '!$TURBO_ROOT$/out/tmp',
      ]),
    ).toEqual({
      files: ['dist/**', '!dist/**/*.map'],
      workspaceFiles: ['out/**', '!out/tmp'],
    })
  })

  it('negations with no positive beside them take back nothing and are dropped', async () => {
    expect(await outputsOf(['dist/**', '!$TURBO_ROOT$/out/tmp'])).toEqual({ files: ['dist/**'] })
    expect(await outputsOf(['!dist/cache'])).toEqual({ files: [] })
  })
})

// Turbo's `with` runs sidecars beside a task (`web#dev` with `api#dev`).
// It was a "no vx equivalent" todo, and `vx run web#dev` started no api.
describe('turbo-map: `with`', () => {
  const task = (m: Awaited<ReturnType<typeof map>>, pkg: string, name: string) =>
    m.projects.find((p) => p.name === pkg)!.tasks.find((t) => t.name === name)!
  const PKGS = {
    api: { scripts: { dev: 'serve', build: 'b' } },
    web: { scripts: { dev: 'next dev' } },
  }

  it('a persistent sidecar is an edge; one that ends is a todo, not an edge', async () => {
    const m = await map(
      {
        tasks: {
          build: {},
          dev: { persistent: true, cache: false },
          'web#dev': { persistent: true, cache: false, with: ['api#dev', 'api#build', 'nope#dev'] },
        },
      },
      PKGS,
    )
    const web = task(m, 'web', 'dev')
    expect([web.task?.['dependsOn'], web.todos.filter((t) => t.startsWith('with'))]).toEqual([
      ['api#dev'],
      [
        'with "api#build": not a persistent task — run it beside this one by hand',
        'with "nope#dev": nope declares no dev script — run it beside this one by hand',
      ],
    ])
  })

  // Turbo's with-tailwind example: `ui` has no `dev` script, and its `dev`
  // exists to start `dev:styles` and `dev:components`. vx planned neither.
  it('a task with no script but sidecars is a group that starts them', async () => {
    const m = await map(
      {
        tasks: {
          dev: { persistent: true, cache: false },
          'dev:css': { persistent: true, cache: false },
          'ui#dev': { persistent: true, cache: false, with: ['dev:css'] },
          lint: { with: ['build'] },
        },
      },
      { ui: { scripts: { 'dev:css': 'tailwind --watch', build: 'b' } } },
    )
    const ui = m.projects[0]!
    expect([
      ui.tasks.map((t) => t.name).sort(),
      task(m, 'ui', 'dev').task,
      task(m, 'ui', 'dev').todos,
    ]).toEqual([['dev', 'dev:css'], { dependsOn: ['dev:css'] }, []])
  })

  it('an edge to a no-script task whose sidecars all end is dropped, not left dangling', async () => {
    const m = await map(
      { tasks: { build: {}, lint: { with: ['build'] }, 'app#check': { dependsOn: ['ui#lint'] } } },
      { ui: { scripts: { build: 'b' } }, app: { scripts: { check: 'c' } } },
    )
    const check = task(m, 'app', 'check')
    expect([check.task?.['dependsOn'], check.todos]).toEqual([
      undefined,
      ['dependsOn "ui#lint": ui declares no lint script — edge dropped'],
    ])
  })

  // with-tailwind's `ui` has no `build` script; its `build` depends on
  // `build:styles` and `build:components`, which Turbo builds before
  // `web#build` and vx dropped. A node with only `^` edges needs no group:
  // core's `^task` already walks past a project without the task.
  it("a no-script task keeps its own package's edges as a group; one with only ^ edges is none", async () => {
    const m = await map(
      {
        tasks: {
          build: { dependsOn: ['^build'] },
          'build:css': {},
          'ui#build': { dependsOn: ['^build', 'build:css'] },
          'app#check': { dependsOn: ['ui#build'] },
        },
      },
      {
        ui: { scripts: { 'build:css': 'css' } },
        cfg: { scripts: {} },
        app: { scripts: { check: 'c' } },
      },
    )
    expect([
      task(m, 'ui', 'build').task,
      m.projects.find((p) => p.name === 'cfg')!.tasks.map((t) => t.name),
      task(m, 'app', 'check').task?.['dependsOn'],
    ]).toEqual([{ dependsOn: ['^build', 'build:css'] }, [], ['ui#build']])
  })

  // rallly: `build: [^build, ^db:generate]`, and only `database` has a
  // `db:generate` script. `web#build:test` → `^build` reaches `billing`'s
  // script-less build, whose `^db:generate` Turbo runs first; core's walk
  // past `billing` carries only the name it walks for, so the edge was lost.
  it('a no-script task whose ^ edge names another task is a group', async () => {
    const m = await map(
      {
        tasks: {
          build: { dependsOn: ['^build', '^db:generate'] },
          'build:test': { dependsOn: ['^build'] },
          'db:generate': {},
        },
      },
      {
        db: { scripts: { 'db:generate': 'g' } },
        billing: { scripts: {} },
        web: { scripts: { 'build:test': 't' } },
      },
    )
    // No package has a `build` script and `build:test` reaches it as
    // `^build`: Turbo's transit node, key-only over billing's files.
    expect(task(m, 'billing', 'build').task).toEqual({
      cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
      dependsOn: ['^build', '^db:generate'],
      exec: { command: 'true' },
    })
  })

  it('a no-script group whose own edges all drop still exists for the edges that name it', async () => {
    const m = await map(
      {
        tasks: {
          'build:x': {},
          'ui#build': { dependsOn: ['build:x'] },
          'app#check': { dependsOn: ['ui#build'] },
        },
      },
      { ui: { scripts: {} }, app: { scripts: { check: 'c' } } },
    )
    expect([task(m, 'ui', 'build').task, task(m, 'app', 'check').task?.['dependsOn']]).toEqual([
      { dependsOn: [] },
      ['ui#build'],
    ])
  })

  // vx's own examples/turbo: `test` depends on `build`, and `lib` has no
  // tests. No package reaches `lib#test`, so it is no group (a migration
  // wrote it as a fourth task).
  it('a no-script node no other package reaches is no group', async () => {
    const m = await map(
      { tasks: { build: { dependsOn: ['^build'] }, test: { dependsOn: ['build'] } } },
      { lib: { scripts: { build: 'b' } }, app: { scripts: { build: 'b', test: 't' } } },
    )
    expect(m.projects.find((p) => p.name === 'lib')!.tasks.map((t) => t.name)).toEqual(['build'])
  })

  // `turbo run ci` over `ci: { dependsOn: ["lint", "build"] }` with no `ci`
  // script anywhere runs every package's lint and build, and cal.com's
  // `deploy: { dependsOn: ["@calcom/web#build"] }` builds web; vx said no
  // project declares either. A `pkg#task` edge stays in pkg: in all 116
  // of cal.com's packages it made every one a dependent of web.
  it('a no-script name no package has a script for is a group wherever it has an edge of its own', async () => {
    const m = await map(
      {
        tasks: {
          build: { dependsOn: ['^build'] },
          lint: {},
          ci: { dependsOn: ['lint', 'build'] },
          deploy: { dependsOn: ['web#build'] },
          noop: {},
        },
      },
      { web: { scripts: { build: 'b' } }, lib: { scripts: { lint: 'l' } } },
    )
    const tasks = (p: string) =>
      Object.fromEntries(
        m.projects.find((x) => x.name === p)!.tasks.map((t) => [t.name, t.task?.['dependsOn']]),
      )
    expect([tasks('web'), tasks('lib')]).toEqual([
      // `web#build` is web's own: the group stays there, so no package
      // gains a task edge to web that core's reach would follow.
      { build: ['^build'], ci: ['build'], deploy: ['build'] },
      // lib's `build` is Turbo's no-op node over lib's files (G-117).
      { build: ['^build'], lint: undefined, ci: ['lint', 'build'] },
    ])
  })

  it('a pair that names each other is one edge, not a cycle', async () => {
    const m = await map(
      {
        tasks: {
          'api#dev': { persistent: true, cache: false, with: ['web#dev'] },
          'web#dev': { persistent: true, cache: false, with: ['api#dev'] },
        },
      },
      PKGS,
    )
    expect([
      task(m, 'api', 'dev').task?.['dependsOn'],
      task(m, 'web', 'dev').task?.['dependsOn'],
    ]).toEqual([undefined, ['api#dev']])
  })
})

// Turbo's non-monorepo example: no workspaces, so turbo.json's plain tasks
// run on the root package. Mapped as a `//#` holder only, it planned none.
describe('turbo-map: a single-package repo', () => {
  it("runs turbo.json's plain tasks on the root package; a monorepo root still holds only //#", async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { outputs: ['dist/**'] }, '//#fmt': {} } }),
    )
    const rootMeta = (scripts: Record<string, string>): ProjectMeta => ({
      name: 'solo',
      dir: root,
      packageJson: { name: 'solo', scripts } as never,
      configPath: null,
    })
    const names = async (metas: ProjectMeta[]) =>
      (await mapTurboWorkspace(root, metas, opts)).projects.map((p) => [
        p.name,
        p.tasks.map((t) => t.name).sort(),
      ])
    const scripts = { build: 'b', fmt: 'f' }
    await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
    const member: ProjectMeta = {
      name: 'a',
      dir: path.join(root, 'packages', 'a'),
      packageJson: { name: 'a', scripts: { build: 'b' } } as never,
      configPath: null,
    }
    expect([await names([rootMeta(scripts)]), await names([rootMeta(scripts), member])]).toEqual([
      [['solo', ['build']]],
      [
        ['solo', ['fmt']],
        ['a', ['build']],
      ],
    ])
  })
})

describe('turbo-map: a transit node', () => {
  // A `^self` task some package runs is one too where a package lacks the
  // script (with-vite's `ui#build`); one no package runs or depends on is not.
  it('is a key-only task in each package; so is a ^self task some package runs, where the script is missing', async () => {
    const m = await map(
      {
        tasks: {
          transit: { dependsOn: ['^transit'] },
          build: { dependsOn: ['^build'] },
          lone: { dependsOn: ['^lone'] },
          test: { dependsOn: ['transit', 'build'] },
        },
      },
      { lib: { scripts: { build: 'b' } }, cfg: { scripts: { test: 't' } } },
    )
    const names = (pkg: string) =>
      m.projects
        .find((p) => p.name === pkg)!
        .tasks.map((t) => t.name)
        .sort()
    const transit = m.projects
      .find((p) => p.name === 'cfg')!
      .tasks.find((t) => t.name === 'transit')!
    expect([
      names('lib'),
      names('cfg'),
      (transit.task!['exec'] as { command: string }).command,
      transit.task?.['dependsOn'],
      transit.task?.['cache'] !== undefined,
    ]).toEqual([['build', 'transit'], ['build', 'test', 'transit'], 'true', ['^transit'], true])
  })
})

// cal.com: a shared `post-install` writes `../../node_modules/@prisma/client/**`
// from every package with the script. One workspace path, no edge between
// them, and core refused the whole run over the first pair.
describe('turbo-map: a workspace output two projects declare', () => {
  it('stays cached on the first; the next runs uncached, with a todo', async () => {
    const m = await map(
      { tasks: { gen: { outputs: ['../../shared/**'] } } },
      { a: { scripts: { gen: 'g' } }, b: { scripts: { gen: 'g' } } },
    )
    const [a, b] = m.projects.map((p) => p.tasks[0]!)
    expect([
      (a!.task!['cache'] as { outputs: { workspaceFiles: string[] } }).outputs.workspaceFiles,
      b!.task?.['cache'],
      b!.todos,
    ]).toEqual([
      ['shared/**'],
      undefined,
      [
        'declares the workspace output "shared/**" that a#gen also declares — vx cleans a task\'s outputs before it runs and before a restore, so two cached tasks on one path would delete each other\'s work; this one runs uncached. Give it its own output path to cache it.',
      ],
    ])
  })
})
