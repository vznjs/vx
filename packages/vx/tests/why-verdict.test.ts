// A changed key's verdict names what moved. A key that moved only by a
// declared environment variable read "cache key changed between the
// previous run and this one (inputs differ)" over a table to scan; the
// verdict now says `cache key changed: env MODE` in one line.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/a.txt > out.txt', env: { passThrough: ['MODE'] } },
        inputs: { files: ['src/**'], env: ['MODE'] }, cache: { outputs: { files: ['out.txt'] } },
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
        '✗ vx why  no recorded run zzz (vx last --list shows recent runs)',
      ])
    },
    TIMEOUT,
  )
})

// An upstream row's advice named the task to ask next even where asking
// leads nowhere: a group records no run (`vx why app#all` read "no
// recorded runs"), and a dependency added or removed did not move a key,
// it joined or left the graph.
describe('vx why advice for an upstream row leads somewhere', () => {
  const LIB = `export default { tasks: {
    build: { exec: { command: 'cat src.txt > out.txt' }, inputs: { files: ['src.txt'] }, cache: { outputs: { files: ['out.txt'] } } },
  } }`
  const todo = (out: string): string[] =>
    out
      .split('\n')
      .filter((l) => /^ {4}upstream {2}/.test(l))
      .map((l) => l.trim())
  let root = ''
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a group upstream names the member whose key moved',
    async () => {
      root = await makeWorkspace({ prefix: 'vx-why-group-', edges: { app: ['lib'] } })
      for (const [name, config] of [
        ['lib', LIB],
        [
          'app',
          `export default { tasks: {
            all: { dependsOn: ['^build'] },
            pack: { exec: { command: 'cat ../lib/out.txt > packed.txt' }, dependsOn: ['all'], inputs: { files: ['vx.config.mjs'], tasks: ['all'] }, cache: { outputs: { files: ['packed.txt'] } } },
          } }`,
        ],
      ] as const) {
        const dir = path.join(root, 'packages', name)
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
        await writeFile(path.join(dir, 'vx.config.mjs'), config)
      }
      await writeFile(path.join(root, 'packages', 'lib', 'src.txt'), 'v1\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      await vx(root, ['run', 'app#pack'])
      await writeFile(path.join(root, 'packages', 'lib', 'src.txt'), 'v2\n')
      await vx(root, ['run', 'app#pack'])
      const why = await vx(root, ['why', 'app#pack'])
      expect(why.code).toBe(0)
      expect(why.out).toContain('lib#build')
      expect(why.out).not.toContain('`vx why app#all`')
      expect(why.out).toContain('app#pack ← app#all ← lib#build ← file packages/lib/src.txt')
    },
    TIMEOUT,
  )

  it(
    'an added or removed upstream says the graph changed, not that a key moved',
    async () => {
      const ws = await makeWorkspace({ prefix: 'vx-why-edge-', edges: { app: ['lib'] } })
      try {
        for (const [name, config] of [
          ['lib', LIB],
          ['lib2', LIB],
          [
            'app',
            `export default { tasks: {
              build: { exec: { command: 'echo x > packed.txt' }, dependsOn: ['^build'], inputs: { files: ['vx.config.mjs'] }, cache: { outputs: { files: ['packed.txt'] } } },
            } }`,
          ],
        ] as const) {
          const dir = path.join(ws, 'packages', name)
          await mkdir(dir, { recursive: true })
          await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
          await writeFile(path.join(dir, 'vx.config.mjs'), config)
          await writeFile(path.join(dir, 'src.txt'), `${name}\n`)
        }
        const git = gitIn(ws)
        git('add', '-A')
        git('commit', '-q', '-m', 'init')
        await vx(ws, ['run', 'app#build'])
        const file = path.join(ws, '.vx', 'workspace.mjs')
        const src = await Bun.file(file).text()
        expect(src).toContain('{"app":["lib"]}')
        await writeFile(file, src.replace('{"app":["lib"]}', '{"app":["lib2"]}'))
        await vx(ws, ['run', 'app#build'])
        const why = await vx(ws, ['why', 'app#build'])
        expect(why.code).toBe(0)
        expect(todo(why.out)).toEqual([
          'upstream  a dependency joined or left the graph (lib#build removed, lib2#build added): its `dependsOn` or a project edge changed, which re-keys the task by design',
        ])
      } finally {
        await rm(ws, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// A key that folds a task with no `inputs` is new every run, so the task
// never hits; the verdict read "inputs differ" over a detail blaming a
// prune, and named neither the cause nor the task to fix.
describe('vx why names the task with no inputs that keeps a key from hitting', () => {
  let root = ''
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-why-keyless-', git: false })
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        gate: { exec: { command: 'true' } },
        build: {
          dependsOn: ['gate'],
          exec: { command: 'echo hi > out.txt' },
          inputs: { files: ['vx.config.mjs'] }, cache: { outputs: { files: ['out.txt'] } },
        },
      } }`,
    )
    const git = gitIn(root)
    git('init', '-q')
    git('add', '-A')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'names the upstream task and the fix',
    async () => {
      await vx(root, ['run', 'app#build'])
      await vx(root, ['run', 'app#build'])
      const why = await vx(root, ['why', 'app#build'])
      expect(why.code).toBe(0)
      expect(verdict(why.out)).toBe(
        'verdict    never cached: its key includes app#gate, which declares no `inputs`, so each run derives a new key; declare inputs on app#gate',
      )
    },
    TIMEOUT,
  )
})

// A run with `--exclude-dependencies` keys the dropped dependency but saves
// nothing built on it (the summary says `not saved`); the next run on the
// key read "its save failed, or it was pruned since".
describe('vx why after a run that left a dependency out', () => {
  it(
    'names --exclude-dependencies, not a failed save or a prune',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-why-excluded-', git: false })
      try {
        const app = path.join(root, 'packages', 'app')
        await mkdir(app, { recursive: true })
        await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
        await writeFile(path.join(app, 'a.txt'), 'a')
        await writeFile(
          path.join(app, 'vx.config.mjs'),
          `export default { tasks: {
            build: { exec: { command: 'true' }, inputs: { files: ['a.txt'] }, cache: { outputs: { files: [] } } },
            test: { dependsOn: ['build'], exec: { command: 'true' }, inputs: { files: ['a.txt'] }, cache: { outputs: { files: [] } } },
          } }`,
        )
        const git = gitIn(root)
        git('init', '-q')
        git('add', '-A')
        await vx(root, ['run', 'app#test', '--exclude-dependencies'])
        await vx(root, ['run', 'app#test', '--exclude-dependencies'])
        expect(verdict((await vx(root, ['why', 'app#test'])).out)).toBe(
          'verdict    cache key unchanged — the previous run on this key built on a dependency it left out (app#build, --exclude-dependencies), so it saved nothing and there was nothing to hit',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
