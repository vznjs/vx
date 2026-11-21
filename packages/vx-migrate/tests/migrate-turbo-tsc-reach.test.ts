// Effect's `@effect/ai-openrouter` tsconfig referenced `../openai`, which its
// package.json did not name: `tsc -b` built openai inside openrouter's task,
// unordered with openai's own build. The scripts mapper names it; a Turbo
// build with the same command gets the same TODO.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-tsc-reach-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: a `tsc -b` reaching an undeclared package', () => {
  it('gets a TODO naming the package to depend on', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
    )
    const dir = (n: string) => path.join(root, 'packages', n)
    for (const n of ['openai', 'router']) {
      await mkdir(dir(n), { recursive: true })
      await writeFile(
        path.join(dir(n), 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { composite: true, outDir: 'dist' },
          references: n === 'router' ? [{ path: '../openai' }] : [],
        }),
      )
    }
    const meta = (n: string, extra: object = {}): PackageMeta => ({
      name: n,
      dir: dir(n),
      packageJson: { name: n, scripts: { build: 'tsc -b' }, ...extra } as never,
      configPath: null,
    })
    const reach = async (extra: object) =>
      (await migrateTurbo(root, [meta('openai'), meta('router', extra)])).projects
        .find((p) => p.name === 'router')!
        .tasks.find((t) => t.name === 'build')!
        .todos.filter((d) => d.startsWith('`tsc -b` builds'))
    expect(await reach({})).toEqual([
      expect.stringContaining(
        '`tsc -b` builds `openai` through tsconfig "references", but this package does not depend on it',
      ),
    ])
    // CONTROL: a dependency orders it under `^build`.
    expect(await reach({ devDependencies: { openai: 'workspace:*' } })).toEqual([])
  })
})
