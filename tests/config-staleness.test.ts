// Config-loading defects whose symptom is a STALE CACHE HIT — vx replaying
// an artifact built from inputs that have since changed.
//
// 1. A config's IMPORT CLOSURE going stale in a long-lived process.
// 2. A typo'd cache-key field being silently dropped, so the task hashes
//    as if the field were never written.
//
// The loader busts Bun's module cache with a hash of the config file's
// OWN bytes, but Bun caches an evaluated module by resolved specifier —
// an `import './preset.js'` inside the config resolves to the same key
// regardless of the entry's bust, so a busted entry re-evaluates against
// the CACHED preset. Shared presets are the documented composition
// mechanism (`vx migrate` generates one), so in a `vx watch` session a
// preset edit was invisible for the life of the process. Worse: the
// resolved config feeds the cache key, so vx reported `up-to-date` for a
// command that had changed on disk — a stale hit.
//
// Both cases run IN-PROCESS on purpose. Driving the real CLI spawns a
// fresh process per run, which can never reproduce this; and the fs.watch
// path is a known load-flake. Two `run()` calls with an edit in between
// are exactly what a watch cycle does, minus the timing.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '../src/workspace/project-loader.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const TIMEOUT = 30_000

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    const out = new TextDecoder().decode(p.stdout)
    const err = new TextDecoder().decode(p.stderr)
    throw new Error(`git ${args.join(' ')} exited ${p.exitCode}: ${err}${out}`)
  }
}

const silentLogger = (): Logger => ({
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
})

describe('config import closure freshness', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-closure-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a repeat load in the same process sees an edited preset', async () => {
    const preset = path.join(root, 'vx-preset.mjs')
    const config = path.join(root, 'vx.config.mjs')
    await writeFile(preset, `export const COMMAND = 'echo v1'\n`)
    await writeFile(
      config,
      `import { COMMAND } from './vx-preset.mjs'\n` +
        `export default { tasks: { build: { exec: { command: COMMAND } } } }\n`,
    )

    const first = await loadProjectConfig(config)
    expect(first.tasks?.build?.exec?.command).toBe('echo v1')

    // Only the PRESET changes — the config's own bytes are untouched,
    // which is precisely what the content-hash bust cannot see.
    await writeFile(preset, `export const COMMAND = 'echo v2'\n`)

    const second = await loadProjectConfig(config)
    expect(second.tasks?.build?.exec?.command).toBe('echo v2')
  })

  it(
    'a re-run in the same process does not serve a cache hit for a changed preset',
    async () => {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
      await mkdir(path.join(root, 'src'), { recursive: true })
      await writeFile(path.join(root, 'src', 'in.txt'), 'in')
      await writeFile(
        path.join(root, 'vx-preset.mjs'),
        `export const COMMAND = 'echo v1 > out.txt'\n`,
      )
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `import { COMMAND } from './vx-preset.mjs'\n` +
          `export default {\n` +
          `  tasks: {\n` +
          `    build: {\n` +
          `      exec: { command: COMMAND },\n` +
          `      cache: {\n` +
          `        inputs: { files: ['src/**'] },\n` +
          `        outputs: { files: ['out.txt'] },\n` +
          `      },\n` +
          `    },\n` +
          `  },\n` +
          `}\n`,
      )
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')

      const doRun = async (): Promise<string | undefined> => {
        const summary = await run({ cwd: root, tasks: ['build'], log: silentLogger() })
        expect(summary.ok).toBe(true)
        return summary.outcomes.find((o) => o.node.taskName === 'build')?.status
      }

      expect(await doRun()).toBe('success')
      expect(await doRun()).toBe('cache-hit')

      // The command a watch cycle would now run differs. The task must
      // re-execute, and the new bytes must land on disk.
      await writeFile(
        path.join(root, 'vx-preset.mjs'),
        `export const COMMAND = 'echo v2 > out.txt'\n`,
      )

      expect(await doRun()).toBe('success')
      expect((await Bun.file(path.join(root, 'out.txt')).text()).trim()).toBe('v2')
    },
    TIMEOUT,
  )
})

describe('a typo in a cache-key field', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-typo-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'is refused by the real CLI instead of hashing as if it were absent',
    async () => {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
      await mkdir(path.join(root, 'pkg'), { recursive: true })
      await writeFile(path.join(root, 'shared.txt'), 'CONTENT-V1')
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            build: {
              exec: { command: 'cat shared.txt > out.txt' },
              cache: {
                inputs: { files: ['pkg/**'], workspaceFile: ['shared.txt'] },
                outputs: { files: ['out.txt'] },
              },
            },
          },
        }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')

      const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
      const proc = Bun.spawn([process.execPath, bin, 'run', 'build'], {
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
      expect(code).not.toBe(0)
      expect(`${out}${err}`).toMatch(/cache\.inputs has unknown field "workspaceFile"/)
    },
    TIMEOUT,
  )
})
