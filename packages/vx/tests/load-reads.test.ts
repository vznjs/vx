// A run reads each root file once (workspace/load-reads.ts). Finding the
// root, listing its package globs and folding the workspace fingerprint
// each read `pnpm-workspace.yaml` for themselves — three probes and three
// reads per run (strace of a 100-package run, 2026-09-24). The count is
// taken where vx asks: every `Bun.file` operation on a path under the
// fixture root, by path, across one `prepareRun`. What Bun's own module
// loader reads is not in it; `read-once.unsafe.test.ts` counts that with
// strace.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Logger, RunOptions } from '../src/orchestrator/index.js'
import { prepareRun } from '../src/orchestrator/index.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { gitInit } from './helpers/workspace.js'

const TIMEOUT = 30_000

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
  await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
  await project('packages', 'a')
  gitInit(root)
})

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
    if (rel.startsWith('.vx')) return f
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
    'pnpm-workspace.yaml is probed and read once across the root, the globs and the fingerprint',
    async () => {
      const ops = await fileOps(async () => {
        expect(await prepare()).toEqual(['a#build'])
      })
      expect(ops).toEqual({
        'pnpm-workspace.yaml': ['exists', 'bytes'],
        // The fingerprint's other files: absent, one probe each.
        'pnpm-lock.yaml': ['exists'],
        'package-lock.json': ['exists'],
        'npm-shrinkwrap.json': ['exists'],
        'yarn.lock': ['exists'],
        'bun.lock': ['exists'],
        'bun.lockb': ['exists'],
        '.yarnrc.yml': ['exists'],
        '.npmrc': ['exists'],
        'bunfig.toml': ['exists'],
        // The workspace config by precedence: three absent names, then the file.
        'vx.workspace.ts': ['exists'],
        'vx.workspace.mts': ['exists'],
        'vx.workspace.js': ['exists'],
        'vx.workspace.mjs': ['exists', 'bytes'],
        // Discovery's one read of the manifest, the loader's of the config.
        'packages/a/package.json': ['text'],
        'packages/a/vx.config.mjs': ['bytes'],
        // The git index, once: its hash keys the blob-size verdict (A-60).
        '.git/index': ['bytes'],
      })
    },
    TIMEOUT,
  )

  it(
    "a --filter run discovers the workspace once: the run takes the selection pass's projects",
    async () => {
      // Differential: with `discovered` not handed from resolveFilters to
      // the run, discovery reads each member manifest a second time.
      const ops = await fileOps(async () => {
        const parsed = parseRunArgs(['build', '--filter', 'a'])
        const opts = (await resolveRunOptions(parsed, root, parsed.tasks)) as RunOptions
        const p = await prepareRun({ ...opts, concurrency: 1 }, log)
        p.cache.close()
        expect([...p.nodes.keys()]).toEqual(['a#build'])
      })
      expect(ops['packages/a/package.json']).toEqual(['text'])
    },
    TIMEOUT,
  )

  it(
    "a run from inside a project discovers the workspace once: the run takes the cwd lookup's projects",
    async () => {
      // Differential: with the cwd lookup's discovery not handed to the
      // run, discovery (every `discover` hook with it) runs twice.
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
      // Discovery's read is the `text`; the `exists` + `bytes` pairs are the
      // root search from `packages/a`, one per lookup of the root.
      expect(ops['packages/a/package.json']?.filter((op) => op === 'text')).toEqual(['text'])
    },
    TIMEOUT,
  )

  it(
    'a watch cycle is a new run: the next run in the process reads the edited manifest',
    async () => {
      // `vx watch` runs every cycle in one process. What a run learns is
      // held for that run only, so a package added by editing the globs
      // joins the very next one.
      expect(await prepare()).toEqual(['a#build'])
      await project('libs', 'b')
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "libs/*"\n',
      )
      expect(await prepare()).toEqual(['a#build', 'b#build'])
    },
    TIMEOUT,
  )
})
