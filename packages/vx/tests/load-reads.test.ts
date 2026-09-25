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
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun } from '../src/orchestrator/index.js'
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
        // The workspace config by precedence: three absent names, then the file.
        'vx.workspace.ts': ['exists'],
        'vx.workspace.mts': ['exists'],
        'vx.workspace.js': ['exists'],
        'vx.workspace.mjs': ['exists', 'bytes'],
        // Discovery's one read of the manifest, the loader's of the config.
        'packages/a/package.json': ['text'],
        'packages/a/vx.config.mjs': ['bytes'],
      })
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
