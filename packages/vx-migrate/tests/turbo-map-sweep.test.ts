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
