// SRT reads a Linux path holding `*` or `?` as a glob, as it does `[`
// (B-57, B-59, B-60), and no spelling makes either literal: a read grant
// of `a*b.txt` also granted `aXb.txt`, a write grant holding one was
// dropped, and a project under `w*s/` granted its siblings' files. A
// backslash SRT skips outright: Bun's realpath refuses such a path, so a
// sandboxed project under `back\\slash/` saw nothing and ran in $HOME.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { bindableReads, bindableWrites } from '../src/exec/sandbox-binds.js'
import { sandboxRequestFor } from '../src/orchestrator/sandbox-request.js'
import type { TaskNode } from '../src/graph/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const linux = process.platform === 'linux'

describe.skipIf(!linux)('a grant holding * or ?', () => {
  it('a read grant is left out and said once; a bracket is not', () => {
    const said: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
      said.push(String(s))
      return true
    })
    try {
      // A trailing `/**` is SRT's to strip, not a glob it reads.
      const grants = [
        '/w/p/a*b.txt',
        '/w/p/q?.txt',
        '/w/p/b\\s.txt',
        '/w/p/[id].tsx',
        '/w/p/x.txt',
        '/w/d/**',
      ]
      expect(bindableReads(grants)).toEqual(['/w/p/[id].tsx', '/w/p/x.txt', '/w/d/**'])
      bindableReads(grants)
      expect(said).toEqual([
        `[vx] sandbox: the read grant /w/p/a*b.txt holds a *, which the Linux sandbox reads as ` +
          `a pattern that also matches its siblings, so it is not granted. Rename it, or grant ` +
          `the directory above it: /w/p/\n`,
        `[vx] sandbox: the read grant /w/p/q?.txt holds a ?, which the Linux sandbox reads as ` +
          `a pattern that also matches its siblings, so it is not granted. Rename it, or grant ` +
          `the directory above it: /w/p/\n`,
        `[vx] sandbox: the read grant /w/p/b\\s.txt holds a backslash, which the Linux sandbox ` +
          `cannot resolve, so it is not granted. Rename it, or grant the directory above it: ` +
          `/w/p/\n`,
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it('a write grant is left out of the binds and said once', () => {
    const said: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
      said.push(String(s))
      return true
    })
    try {
      // `dist/` does not exist, so it binds as a file would: its directory.
      expect(bindableWrites(['/w/p/out*/', '/w/p/o\\ut/', '/w/p/dist/', '/w/d/**'])).toEqual([
        '/w/p',
        '/w/d/**',
      ])
      expect(said).toEqual([
        `[vx] sandbox: the write grant /w/p/out*/ holds a *, and the Linux sandbox mounts no ` +
          `write path that does, so a write under it is refused. Grant the directory above it ` +
          `instead: /w/p/\n`,
        `[vx] sandbox: the write grant /w/p/o\\ut/ holds a backslash, and the Linux sandbox ` +
          `mounts no write path that does, so a write under it is refused. Grant the directory ` +
          `above it instead: /w/p/\n`,
      ])
    } finally {
      spy.mockRestore()
    }
  })
})

describe.skipIf(process.platform === 'win32')('a project under a directory holding * or ?', () => {
  let root = ''
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-glob-req-')))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const request = (dir: string) => {
    const node: TaskNode = {
      id: 'proj#build',
      projectName: 'proj',
      projectDir: dir,
      taskName: 'build',
      config: { exec: { command: 'true' } },
      deps: [],
      requested: true,
    }
    return sandboxRequestFor(node, { allow: { write: ['dist/'] } }, root, undefined).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    )
  }

  it.each(['w*s', 'w?s'])('%s is refused with the directory named', async (name) => {
    const dir = path.join(root, name, 'proj')
    await mkdir(dir, { recursive: true })
    expect(await request(dir)).toBe(
      `exec.sandbox: ${dir} holds [, ], * or ?, which the sandbox runtime reads as a ` +
        `pattern, not a name — rename the directory, or run the task without exec.sandbox`,
    )
  })

  // The fact the backslash rows lean on: when it stops holding, they can go.
  it.skipIf(!linux)(
    "Bun's realpath refuses a path holding a backslash that stat finds",
    async () => {
      const dir = path.join(root, 'back\\slash')
      await mkdir(dir)
      expect(statSync(dir).isDirectory()).toBe(true)
      expect(() => realpathSync(dir)).toThrow('ENOENT')
    },
  )

  it.skipIf(!linux)('a backslash is refused with the directory named', async () => {
    const dir = path.join(root, 'back\\slash', 'proj')
    await mkdir(dir, { recursive: true })
    expect(await request(dir)).toBe(
      `exec.sandbox: ${dir} holds a backslash, which the Linux sandbox cannot resolve, so ` +
        `it mounts none of the project — rename the directory, or run the task without exec.sandbox`,
    )
  })

  it('CONTROL: the same project a directory over resolves', async () => {
    const dir = path.join(root, 'ws', 'proj')
    await mkdir(dir, { recursive: true })
    expect(await request(dir)).toBe('resolved')
  })
})

const available = await sandboxAvailable('sandbox glob-char test')

describe.skipIf(!available || !linux)('a sandboxed read of a file named with * or ?', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-glob-')))
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  it('grants no glob sibling, and the refused read is reported', async () => {
    const proj = path.join(dir, 'proj')
    await mkdir(proj, { recursive: true })
    for (const f of ['a*b.txt', 'aXb.txt', 'q?.txt', 'qZ.txt', 'b\\s.txt', 'x.txt']) {
      await writeFile(path.join(proj, f), f)
    }
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const r = await runSandboxed({
        command: "cat x.txt; cat aXb.txt qZ.txt 'a*b.txt' 'b\\s.txt'; true",
        cwd: proj,
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig(
          { allow: { read: ['a\\*b.txt', 'q\\?.txt', 'b\\\\s.txt', 'x.txt'] } },
          proj,
        ),
      })
      expect([
        r.stdout,
        r.violations.map((v) => String(v.target)).sort((a, b) => a.localeCompare(b)),
      ]).toEqual([
        'x.txt',
        ['a*b.txt', 'aXb.txt', 'b\\s.txt', 'qZ.txt'].map((f) => path.join(proj, f)),
      ])
    } finally {
      spy.mockRestore()
    }
  })
})
