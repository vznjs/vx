// An input wholly inside the task's own output (`lib` in both, or a
// `$TURBO_ROOT$/packages/a/lib/**` input beside a `lib` output): core
// refuses it, since vx cleans the outputs before the task runs, and that
// refused the whole `vx lock` of a migrated workspace. Dropped with a
// TODO, as nx() drops it. Found by a turbo.json fuzz through `vx lock`.

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

it('drops an input inside the task’s own output, with a todo', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-toi-'))
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
    JSON.stringify({ name: 'a', scripts: { build: 'x', lint: 'x', test: 'x' } }),
  )
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      tasks: {
        build: { inputs: ['src/**', 'lib', 'dist/*.d.ts'], outputs: ['lib', 'dist/**'] },
        lint: { inputs: ['src/**', '$TURBO_ROOT$/packages/a/lib/**'], outputs: ['lib'] },
        // The control: an output a `!` takes partly back is left as written.
        test: { inputs: ['src/**', 'out/**'], outputs: ['out/**', '!out/keep/**'] },
      },
    }),
  )
  const proc = Bun.spawn([process.execPath, BIN, '--no-install'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  const tasks = (await loadProjectConfig(path.join(dir, 'vx.config.ts'))).tasks!
  expect(tasks['build']!.inputs).toEqual({ files: ['src/**', 'package.json'] })
  expect(tasks['lint']!.inputs).toEqual({ files: ['src/**', 'package.json'] })
  expect(tasks['test']!.inputs).toEqual({ files: ['src/**', 'out/**', 'package.json'] })
  expect(out).toContain('input "lib" lies inside this task’s own output lib — dropped')
  expect(out).toContain('input "dist/*.d.ts" lies inside this task’s own output dist — dropped')
  expect(out).toContain(
    'input "packages/a/lib/**" lies inside this task’s own output lib — dropped',
  )
})
