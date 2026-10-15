// Turbo never cleans an output and vx cleans one before every run. The
// written config for `outputs: ["dist/**"]` beside a committed
// `dist/keep.js` deleted it on the first `vx run build`; turbo() takes
// such files back each run, and the written configs did not.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '@vzn/vx'
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
      outputs: (t.task as { cache: { outputs: unknown } }).cache.outputs,
      todos: t.todos,
    }).toEqual({
      outputs: { files: ['dist/**'] },
      todos: [],
    })
  })
})
