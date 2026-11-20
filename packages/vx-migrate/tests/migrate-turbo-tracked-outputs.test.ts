// Turbo never cleans an output and vx cleans one before every run. The
// written config for `outputs: ["dist/**"]` beside a committed
// `dist/keep.js` deleted it on the first `vx run build`; turbo() takes
// such files back each run, and the written configs did not.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-tracked-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: a committed file under an output', () => {
  it('stays in the output with no `!` and no todo: core never cleans it', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } } }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(path.join(dir, 'dist'), { recursive: true })
    await writeFile(path.join(dir, 'dist', 'keep.js'), 'keep\n')
    await writeFile(path.join(dir, 'dist', 'stale.js'), 'stale\n')
    const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
    git('init', '-q')
    git('add', 'turbo.json', 'packages/a/dist/keep.js')
    const metas: PackageMeta[] = [
      {
        name: 'a',
        dir,
        packageJson: { name: 'a', scripts: { build: 'tsc' } } as never,
        configPath: null,
      },
    ]
    const t = (await migrateTurbo(root, metas)).projects[0]!.tasks[0]!
    expect({
      outputs: (t.task as { outputs: unknown; cache: true }).outputs,
      todos: t.todos,
    }).toEqual({
      outputs: { files: ['dist/**'] },
      todos: [],
    })
  })
})

// solid: `@solidjs/web#types` outputs the committed `jsx/jsx.d.ts` it
// regenerates, and `build` depends on `types`. The `!` build's `**/*` got
// for it was dropped (a committed output is also a source), so build's key
// folded `types` and read its output: `vx lock` refused the written config.
describe('migrateTurbo: a committed output a dependant reads', () => {
  it('stays taken back from a reader that folds the writer, which stays cached', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: {
          types: { outputs: ['types/**', 'jsx/jsx.d.ts'] },
          build: { dependsOn: ['types'], outputs: ['dist/**'] },
          // CONTROL: no edge to types, so no key holds the committed bytes for it.
          test: { outputs: [] },
        },
      }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(path.join(dir, 'jsx'), { recursive: true })
    await writeFile(path.join(dir, 'jsx', 'jsx.d.ts'), 'export {}\n')
    const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
    git('init', '-q')
    git('add', 'turbo.json', 'packages/a/jsx/jsx.d.ts')
    const metas: PackageMeta[] = [
      {
        name: 'a',
        dir,
        packageJson: {
          name: 'a',
          scripts: { types: 'gen', build: 'rollup', test: 'vitest' },
        } as never,
        configPath: null,
      },
    ]
    const tasks = (await migrateTurbo(root, metas)).projects[0]!.tasks
    const of = (name: string) => tasks.find((t) => t.name === name)!
    const files = (name: string) =>
      (of(name).task as { inputs?: { files: string[] } }).inputs?.files
    expect(files('build')).toContain('!jsx/jsx.d.ts')
    expect(of('build').todos).toEqual([])
    // Its key would read another task's output, which core refuses at load.
    expect(files('test')).toBeUndefined()
    expect(of('test').todos).toEqual([
      "reads the committed jsx/jsx.d.ts, which its inputs take back with a#types's outputs — " +
        'task runs uncached; declare its inputs in a vx.config to cache it',
    ])
  })
})
