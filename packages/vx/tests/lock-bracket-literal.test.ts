// A bare `app/[id]/**` is a class (`app/i`, `app/d`), never the route
// directory `app/[id]`. Beside another glob it matched nothing silently,
// so an edit under the route was a stale hit (vercel/turborepo#14850).
// `vx lock` refuses it when the literal path exists, naming `app/\[id\]`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { TIMEOUT } from './helpers/orchestrator-fixture.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

/** A git workspace with project `a` holding `src/x` and `app/[id]/page.ts`. */
async function workspace(task: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-lock-bracket-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  const dir = path.join(root, 'packages', 'a')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await mkdir(path.join(dir, 'app', '[id]'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'x'), 'x')
  await writeFile(path.join(dir, 'app', '[id]', 'page.ts'), 'one')
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), `export default { tasks: { build: ${task} } }\n`)
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
  Bun.spawnSync({
    cmd: ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'],
    cwd: root,
  })
  return root
}

function vx(root: string, args: string[]) {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, CI: '', VX_LOCK_REVIEW_FILES: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

const task = (inputs: string[], outputs: string[] = []) =>
  `{ exec: { command: 'cat app/*/page.ts' }, inputs: { files: ${JSON.stringify(inputs)} }, cache: { outputs: { files: ${JSON.stringify(outputs)} } } }`

describe('vx lock refuses a bracket class that names an existing path', () => {
  it(
    'an input glob: refused with the escaped form, the lock not written',
    async () => {
      const root = await workspace(task(['src/**', 'app/[id]/**']))
      const r = vx(root, ['lock'])
      expect({
        code: r.code,
        said: r.err.includes('lock not written') && r.err.includes('app/\\[id\\]/**'),
        written: existsSync(path.join(root, '.vx/projects.lock.json')),
      }).toEqual({ code: 1, said: true, written: false })
    },
    TIMEOUT,
  )

  it(
    'a negated input and an output glob are refused too',
    async () => {
      for (const t of [task(['**', '!app/[id]/**']), task(['src/**'], ['app/[id]/page.ts'])]) {
        const r = vx(await workspace(t), ['lock'])
        expect({ code: r.code, said: r.err.includes('app/\\[id\\]') }).toEqual({
          code: 1,
          said: true,
        })
      }
    },
    TIMEOUT,
  )

  it(
    'the escaped route, and a class no literal path holds, lock; an edit under the route misses',
    async () => {
      const root = await workspace(task(['src/**', 'app/\\[id\\]/**', 'src/[xy]']))
      expect(vx(root, ['lock']).code).toBe(0)
      expect(vx(root, ['run', 'build', '--all']).code).toBe(0)
      await writeFile(path.join(root, 'packages/a/app/[id]/page.ts'), 'two')
      const r = vx(root, ['run', 'build', '--all'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/success miss +packages\/a#build/)
    },
    TIMEOUT,
  )
})
