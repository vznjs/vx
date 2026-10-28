// `vx show` lists what a run would see: a config-less package a configured
// one depends on gets the default `build` in a run (its closure loads it),
// so the list shows it there too. `vx show build` does not: no project
// declares it, and `vx run build --all` refuses it (X-145).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeEdges } from './helpers/plugin.js'

// `vx lock`, then `vx show`: show reads the lock.
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 20_000

async function vx(
  root: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('vx show and the default build of a dependency', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-default-build-'))
    // `vx run` needs a work tree.
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    )
    await writeEdges(root, { app: ['lib'] })
    const pkg = async (name: string, json: object, config?: string): Promise<void> => {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, ...json }))
      if (config !== undefined) await writeFile(path.join(dir, 'vx.config.mjs'), config)
    }
    await pkg(
      'app',
      {},
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
          '  project  dir            tasks',
          '  app      packages/app   2 tasks',
          '  lib      packages/lib   1 task, default build (no vx config)',
          '  lone     packages/lone  no vx config',
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
    '`vx show build` names no project, as `vx run build --all` declares none',
    async () => {
      const r = await vx(root, ['show', 'build'])
      expect([r.code, r.out]).toEqual([1, ''])
    },
    TIMEOUT,
  )

  it(
    '`vx show <project>` names the tasks the list does, and `vx run` agrees',
    async () => {
      const list = JSON.parse((await vx(root, ['show', '--format', 'json'])).out) as {
        name: string
        tasks: string[]
      }[]
      for (const name of ['lib', 'lone']) {
        const one = JSON.parse((await vx(root, ['show', name, '--format', 'json'])).out) as {
          config: { tasks?: Record<string, unknown> } | null
        }
        expect([name, Object.keys(one.config?.tasks ?? {})]).toEqual([
          name,
          list.find((p) => p.name === name)!.tasks,
        ])
      }
      // Nothing reaches `lone`: it has no build to show or run.
      expect((await vx(root, ['show', 'lone#build'])).code).toBe(1)
      const run = await vx(root, ['run', 'lone#build'])
      expect([run.code, run.err]).toEqual([1, expect.stringContaining('lone has no vx config')])
      expect((await vx(root, ['show', 'lib#build'])).code).toBe(0)
      expect((await vx(root, ['run', 'lib#build'])).code).toBe(0)
    },
    TIMEOUT,
  )
})
