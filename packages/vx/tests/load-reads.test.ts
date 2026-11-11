// A run reads each root file once. Finding the root, listing its package
// globs and folding the workspace fingerprint each read
// `pnpm-workspace.yaml` for themselves — three probes and three reads per
// run (strace of a 100-package run, 2026-09-24); core now reads no package
// file at all, and a plugin that does reads it once per run. The count is
// taken where vx asks: every `Bun.file` operation on a path under the
// fixture root, by path, across one `prepareRun` over a lock written
// before the count. What Bun's own module
// loader reads is not in it; `read-once.unsafe.test.ts` counts that with
// strace.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { prepareRun, type RunOptions } from '../src/orchestrator/index.js'
import { type Logger } from '../src/report/index.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { gitInit } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const TIMEOUT = 30_000
const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')

const log: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-load-reads-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  // A lockfile plugin's stand-in: it reads the manifests, core does not.
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  await project('packages', 'a')
  gitInit(root)
  lock()
})

// In a child process: an in-process lock would warm the memos the count reads through.
function lock(): void {
  const r = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function project(base: string, name: string): Promise<void> {
  const dir = path.join(root, base, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default {
  tasks: { build: { exec: { command: 'echo ${name}' } } },
}
`,
  )
}

/** Every `Bun.file(<path under root>)` operation during `fn`, by root-relative path. */
async function fileOps(fn: () => Promise<void>): Promise<Record<string, string[]>> {
  const ops: Record<string, string[]> = {}
  const file = Bun.file.bind(Bun)
  const spy = spyOn(Bun, 'file').mockImplementation(((p: string, o?: BlobPropertyBag) => {
    const f = file(p, o)
    if (typeof p !== 'string' || !p.startsWith(`${root}/`)) return f
    const rel = path.relative(root, p)
    if (rel.startsWith('.vx/cache')) return f
    return new Proxy(f, {
      get(target, key) {
        const v = Reflect.get(target, key) as unknown
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          ;(ops[rel] ??= []).push(String(key))
          return (v as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  }) as typeof Bun.file)
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return ops
}

async function prepare(): Promise<string[]> {
  const p = await prepareRun({ cwd: root, tasks: ['build'], concurrency: 1 }, log)
  p.cache.close()
  return [...p.nodes.keys()].sort()
}

describe('a run reads each root file once', () => {
  it(
    'core reads the workspace file and the lock, each once, and no package file',
    async () => {
      const ops = await fileOps(async () => {
        expect(await prepare()).toEqual(['a#build'])
      })
      expect(ops).toEqual({
        // The root lookup's git bound: the fixture is the top-level.
        '.git/HEAD': ['exists'],
        // The root lookup probes the name `vx init` writes, lists `.vx` (no
        // probe of the names it lacks), then stats the file; the loader
        // reads the file it found.
        '.vx/workspace.ts': ['exists'],
        '.vx/workspace.mjs': ['exists', 'bytes'],
        // The projects and their configs come from the lock.
        '.vx/projects.lock.json': ['exists', 'text'],
        // A config the run reads is still there (X-144).
        'packages/a/vx.config.mjs': ['exists'],
        // No package file: the plugin's `discover` answer is the lock's
        // (2026-11-11), and core probes none.
      })
    },
    TIMEOUT,
  )

  it(
    "a --filter run discovers the workspace once: the run takes the selection pass's projects",
    async () => {
      // Discovery reads only the lock, once per process, since a run calls
      // no `discover` hook (2026-11-11): the hooks' manifest reads, which
      // a second discovery repeated, are gone with them.
      const ops = await fileOps(async () => {
        const parsed = parseRunArgs(['build', '--filter', 'a'])
        const opts = (await resolveRunOptions(parsed, root, parsed.tasks)) as RunOptions
        const p = await prepareRun({ ...opts, concurrency: 1 }, log)
        p.cache.close()
        expect([...p.nodes.keys()]).toEqual(['a#build'])
      })
      expect(ops['.vx/projects.lock.json']).toEqual(['exists', 'text'])
    },
    TIMEOUT,
  )

  it(
    "a run from inside a project discovers the workspace once: the run takes the cwd lookup's projects",
    async () => {
      // As above: discovery reads only the lock, once per process.
      const ops = await fileOps(async () => {
        const parsed = parseRunArgs(['build'])
        const opts = (await resolveRunOptions(
          parsed,
          path.join(root, 'packages', 'a'),
          parsed.tasks,
        )) as RunOptions
        const p = await prepareRun({ ...opts, concurrency: 1 }, log)
        p.cache.close()
        expect([...p.nodes.keys()]).toEqual(['a#build'])
      })
      expect(ops['.vx/projects.lock.json']).toEqual(['exists', 'text'])
    },
    TIMEOUT,
  )

  it(
    'a watch cycle is a new run: the next run in the process reads the edited lock',
    async () => {
      // `vx watch` runs every cycle in one process. What a run learns is
      // held for that run only, so a project `vx lock` adds joins the very
      // next one.
      expect(await prepare()).toEqual(['a#build'])
      await project('libs', 'b')
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "libs/*"\n',
      )
      lock()
      expect(await prepare()).toEqual(['a#build', 'b#build'])
    },
    TIMEOUT,
  )
})
