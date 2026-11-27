// A `!$TURBO_ROOT$/` input or output with no positive root glob beside it:
// the input was written as a list of negations alone, which core refuses
// ("selects NOTHING"), and the output's was dropped. Measured on turbo
// 2.11.13: such a negation takes back from the package's own globs
// (`!$TURBO_ROOT$/packages/a/src/gen/**` leaves src/gen out of `src/**`,
// and `dist/x` out of a `dist/**` restore), and one outside it nothing.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '../node_modules/@vzn/vx')

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a root negation with no positive root glob takes back from the package', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-trneg-'))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', workspaces: ['packages/*'], packageManager: 'bun@1.4.4' }),
  )
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'x', lint: 'x' } }),
  )
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      tasks: {
        build: {
          inputs: ['src/**', '!$TURBO_ROOT$/docs/**', '!$TURBO_ROOT$/packages/a/src/gen/**'],
          outputs: ['dist/**', '!$TURBO_ROOT$/packages/a/dist/x/**'],
        },
        lint: { inputs: ['src/**', '!$TURBO_ROOT$/**/*.md'] },
      },
    }),
  )
  const proc = Bun.spawn([process.execPath, BIN, '--no-install'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
  const tasks = (await loadProjectConfig(path.join(dir, 'vx.config.ts'))).tasks!
  expect(tasks['build']!.inputs).toEqual({ files: ['src/**', 'package.json', '!src/gen/**'] })
  expect(tasks['build']!.outputs).toEqual({ files: ['dist/**', '!dist/x/**'] })
  expect(tasks['lint']!.inputs).toEqual({ files: ['src/**', 'package.json', '!**/*.md'] })
})
