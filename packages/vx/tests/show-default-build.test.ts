// `vx show` lists what a run would see: a config-less package a configured
// one depends on gets the default `build` in a run (its closure loads it),
// so the list and `vx show build` show it there too.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

async function vx(root: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, out }
}

describe('vx show and the default build of a dependency', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-default-build-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    )
    const pkg = async (name: string, json: object, config?: string): Promise<void> => {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, ...json }))
      if (config !== undefined) await writeFile(path.join(dir, 'vx.config.mjs'), config)
    }
    await pkg(
      'app',
      { dependencies: { lib: '*' } },
      `
  export default { tasks: { test: { exec: { command: 'true' } } } }
`,
    )
    await pkg('lib', {})
    await pkg('lone', {})
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'the list counts the default build a dependency gets and names its source',
    async () => {
      const r = await vx(root, ['show'])
      expect(r.code).toBe(0)
      expect(r.out).toBe(
        [
          'app   packages/app   2 tasks',
          'lib   packages/lib   1 task (no vx config; default build)',
          'lone  packages/lone  (no vx config)',
          '',
        ].join('\n'),
      )
      const json = JSON.parse((await vx(root, ['show', '--format', 'json'])).out) as {
        name: string
        tasks: string[]
      }[]
      expect(json.map((p) => [p.name, p.tasks])).toEqual([
        ['app', ['test', 'build']],
        ['lib', ['build']],
        ['lone', []],
      ])
    },
    TIMEOUT,
  )

  it(
    '`vx show build` shows it in the dependency too',
    async () => {
      const r = await vx(root, ['show', 'build'])
      expect(r.code).toBe(0)
      expect(r.out.split('\n').filter((l) => l.includes(' — '))).toEqual([
        'app — packages/app',
        'lib — packages/lib',
      ])
    },
    TIMEOUT,
  )
})
