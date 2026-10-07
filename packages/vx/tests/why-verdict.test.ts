// A changed key's verdict names what moved. A key that moved only by a
// declared environment variable read "cache key changed between the
// previous run and this one (inputs differ)" over a table to scan; the
// verdict now says `cache key changed: env MODE` in one line.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/a.txt > out.txt', env: { passThrough: ['MODE'] } },
        cache: { inputs: { files: ['src/**'], env: ['MODE'] }, outputs: { files: ['out.txt'] } },
      },
    },
  }
`

async function vx(root: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { out, code }
}

const verdict = (out: string): string | undefined =>
  out
    .split('\n')
    .find((l) => l.startsWith('  verdict '))
    ?.trim()

describe('vx why names what moved the key', () => {
  let root = ''
  const app = (): string => path.join(root, 'packages', 'app')
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-why-verdict-', git: false })
    await mkdir(path.join(app(), 'src'), { recursive: true })
    await writeFile(path.join(app(), 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app(), 'vx.config.mjs'), CONFIG)
    await writeFile(path.join(app(), 'src', 'a.txt'), 'v1\n')
    const git = gitIn(root)
    git('init', '-q')
    git('add', '-A')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'an env-only change is one line; with a file too, both are named',
    async () => {
      await vx(root, ['run', 'build', '--all'], { MODE: 'dev' })
      await vx(root, ['run', 'build', '--all'], { MODE: 'prod' })
      const env = await vx(root, ['why', 'app#build'])
      expect(env.code).toBe(0)
      expect(verdict(env.out)).toBe('verdict    cache key changed: env MODE')

      await writeFile(path.join(app(), 'src', 'a.txt'), 'v2\n')
      await vx(root, ['run', 'build', '--all'], { MODE: 'test' })
      expect(verdict((await vx(root, ['why', 'app#build'])).out)).toBe(
        'verdict    cache key changed: env MODE, file packages/app/src/a.txt',
      )
    },
    TIMEOUT,
  )

  it(
    'an unchanged key keeps its own verdict (control)',
    async () => {
      // Two runs of its own, so it holds whatever the row above left.
      await vx(root, ['run', 'build', '--all'], { MODE: 'same' })
      await vx(root, ['run', 'build', '--all'], { MODE: 'same' })
      expect(verdict((await vx(root, ['why', 'app#build'])).out)).toStartWith(
        'verdict    cache key unchanged',
      )
    },
    TIMEOUT,
  )

  // X-18: a config edit read "config config"; a bare name refused from
  // inside a project that `vx run` there would pick; an unknown run id
  // read as a known run with no row for the task.
  it(
    'names a config change once, scopes a bare name to the cwd, refuses an unknown run',
    async () => {
      const lib = path.join(root, 'packages', 'lib')
      await mkdir(path.join(lib, 'src'), { recursive: true })
      await writeFile(path.join(lib, 'package.json'), JSON.stringify({ name: 'lib' }))
      await writeFile(path.join(lib, 'vx.config.mjs'), CONFIG)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'v1\n')
      await vx(root, ['run', 'build', '--all'], { MODE: 'same' })
      await writeFile(
        path.join(app(), 'vx.config.mjs'),
        CONFIG.replace('build: {', "build: { description: 'edited',"),
      )
      await vx(root, ['run', 'build', '--all'], { MODE: 'same' })
      expect(verdict((await vx(root, ['why', 'app#build'])).out)).toBe(
        'verdict    cache key changed: config',
      )
      const inApp = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'why', 'build'],
        cwd: app(),
        env: process.env,
      })
      expect([inApp.exitCode, inApp.stdout.toString().split('\n')[0]?.split(' ')[0]]).toEqual([
        0,
        'app#build',
      ])
      const atRoot = Bun.spawnSync({ cmd: [process.execPath, BIN, 'why', 'build'], cwd: root })
      expect(atRoot.stderr.toString()).toContain('"build" ran in 2 projects')
      const unknown = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'why', 'app#build', '--run', 'zzz'],
        cwd: root,
      })
      expect([unknown.exitCode, unknown.stderr.toString().trim()]).toEqual([
        1,
        'vx why: no recorded run zzz (vx last --list shows recent runs)',
      ])
    },
    TIMEOUT,
  )
})
