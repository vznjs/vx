// `vx show` lists what a run would see: a config-less package a configured
// one depends on gets the default `build` in a run (its closure loads it),
// so the list shows it there too. `vx show build` does not: no project
// declares it, and `vx run build --all` refuses it (X-145).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeEdges } from './helpers/plugin.js'
import { vx } from './helpers/vx.js'

// `vx lock`, then `vx show`: show reads the lock.
const TIMEOUT = 30_000

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
          '  Projects 3',
          '  project  dir            tasks',
          '  app      packages/app   2 tasks, default build',
          '  lib      packages/lib   1 task, default build (no vx config)',
          '  lone     packages/lone  no vx config',
          '',
        ].join('\n'),
      )
      const json = JSON.parse((await vx(root, ['show', '--format', 'json'])).out) as {
        name: string
        tasks: string[]
        defaultBuild: boolean
      }[]
      // JSON marks the default build as the text does.
      expect(json.map((p) => [p.name, p.tasks, p.defaultBuild])).toEqual([
        ['app', ['test', 'build'], true],
        ['lib', ['build'], true],
        ['lone', [], false],
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
      // The project view marks it, as the list does.
      expect((await vx(root, ['show', 'app'])).out).toContain('\n  app#build  default\n')
      const app = JSON.parse((await vx(root, ['show', 'app', '--format', 'json'])).out) as {
        defaultBuild: boolean
      }
      expect(app.defaultBuild).toBe(true)
      // The task view too: it read as a build someone declared.
      expect((await vx(root, ['show', 'app#build'])).out).toMatch(/^ {2}app#build +default$/m)
      const one = JSON.parse((await vx(root, ['show', 'app#build', '--format', 'json'])).out) as {
        defaultBuild: boolean
      }
      expect(one.defaultBuild).toBe(true)
      const own = JSON.parse((await vx(root, ['show', 'app#test', '--format', 'json'])).out) as {
        defaultBuild: boolean
      }
      expect(own.defaultBuild).toBe(false)
      // `vx info` names the default builds the list counts: 3 tasks there.
      expect((await vx(root, ['info'])).out).toMatch(
        /^ {2}projects +3 \(1 task, 2 default builds\)$/m,
      )
      const info = JSON.parse((await vx(root, ['info', '--format', 'json'])).out) as {
        tasks: number
        defaultBuilds: number
      }
      expect([info.tasks, info.defaultBuilds]).toEqual([1, 2])
      expect((await vx(root, ['run', 'lib#build'])).code).toBe(0)
    },
    TIMEOUT,
  )

  // A config written after the lock read "no vx config": a user who had
  // just written one went looking for a typo.
  it(
    'a config the lock does not hold yet says so, not "no vx config"',
    async () => {
      const file = path.join(root, 'packages', 'lone', 'vx.config.mjs')
      await writeFile(file, "export default { tasks: { t: { exec: { command: 'true' } } } }\n")
      try {
        const plain = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
        const show = (...args: string[]) =>
          Bun.spawnSync([process.execPath, plain, 'show', ...args], { cwd: root }).stdout.toString()
        expect(show()).toContain(
          '  lone     packages/lone  vx.config.mjs not locked — run vx lock\n',
        )
        expect(show('lone')).toContain('config    vx.config.mjs not locked — run vx lock')
      } finally {
        await rm(file)
      }
    },
    TIMEOUT,
  )
})
