// Unit coverage for the executor's pure logic: glob → output-path mapping and
// placement acceptance. The gRPC-touching half lives in reapi-e2e.test.ts.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  acceptsTask,
  globToOutputPath,
  materialiseOutputs,
  outputPathSets,
} from '../src/executor.js'
import type { ExecuteRequest, TaskPlacement } from '@vzn/vx'

describe('globToOutputPath', () => {
  // vx declares output GLOBS; REAPI wants LITERAL paths. Passing `dist/**`
  // through names a file literally called `dist/**` — the action would return
  // no outputs with no error anywhere, so this mapping is load-bearing.
  it.each([
    ['dist/**', 'dist'],
    ['dist/*.js', 'dist'],
    ['build/out/deep/**/*.map', 'build/out/deep'],
    ['out.txt', 'out.txt'],
    ['a/b/c.txt', 'a/b/c.txt'],
    ['*.js', ''],
    ['**', ''],
    ['out-[ab].txt', ''],
    ['gen?/x', ''],
  ])('%s → %j', (glob, expected) => {
    expect(globToOutputPath(glob)).toBe(expected)
  })
})

describe('outputPathSets', () => {
  const req = (files: string[], workspaceFiles: string[] = []): ExecuteRequest =>
    ({ outputs: { files, workspaceFiles } }) as unknown as ExecuteRequest

  it('dedupes globs collapsing to one prefix and sorts', () => {
    const sets = outputPathSets(req(['dist/**', 'dist/*.map', 'out.txt']), '')
    expect(sets.outputPaths).toEqual(['dist', 'out.txt'])
  })

  it('splits the v2.0 legacy pair: literals are files, prefixes are dirs', () => {
    const sets = outputPathSets(req(['dist/**', 'out.txt']), '')
    expect(sets.legacyFiles).toEqual(['out.txt'])
    expect(sets.legacyDirectories).toEqual(['dist'])
  })

  it('rebases workspaceFiles onto the working directory', () => {
    const sets = outputPathSets(req([], ['packages/app/gen/**']), 'packages/app')
    expect(sets.outputPaths).toEqual(['gen'])
  })

  it('a first-segment wildcard collapses to "" — the whole working directory', () => {
    const sets = outputPathSets(req(['*.js']), '')
    expect(sets.outputPaths).toEqual([''])
    expect(sets.legacyDirectories).toEqual([''])
  })
})

describe('acceptsTask', () => {
  const placement = (over: Partial<TaskPlacement>): TaskPlacement =>
    ({
      taskId: 'a#b',
      projectName: 'a',
      projectDir: '/w/a',
      command: 'true',
      pinnedLocal: false,
      cacheable: true,
      ...over,
    }) as TaskPlacement

  it('takes only cacheable, unpinned tasks', () => {
    // No cache block ⇒ no described inputs ⇒ a worker would run against an
    // empty input root and produce garbage. Decline and let the local
    // executor take it.
    expect(acceptsTask(placement({}))).toBe(true)
    expect(acceptsTask(placement({ cacheable: false }))).toBe(false)
    expect(acceptsTask(placement({ pinnedLocal: true }))).toBe(false)
  })
})

describe('materialiseOutputs: a declared output that cannot be fetched', () => {
  // The output side of the same fail-open the upstream graft had. Core's
  // contract is that after an executor returns, the declared outputs are on
  // disk — save() then tars whatever it finds. Skipping an unfetchable blob
  // means the task "succeeds" and its artifact is cached with a HOLE, under a
  // key claiming a complete build. The stub stands in for a CAS that lost the
  // blob between the action completing and the fetch.
  const stub = (have: Map<string, Uint8Array>) =>
    ({
      batchReadBlobs: async (ds: { hash: string }[]) => {
        const out = new Map<string, Uint8Array>()
        for (const d of ds) {
          const b = have.get(d.hash)
          if (b !== undefined) out.set(d.hash, b)
        }
        return out
      },
      readBlob: async (d: { hash: string }) => have.get(d.hash) ?? null,
    }) as unknown as Parameters<typeof materialiseOutputs>[0]

  const req = (globs: string[], cwd: string): Parameters<typeof materialiseOutputs>[1] =>
    ({
      taskId: 'pkg#build',
      cwd,
      workspaceRoot: path.dirname(cwd),
      outputs: { files: globs, workspaceFiles: [] },
    }) as unknown as Parameters<typeof materialiseOutputs>[1]

  const result = {
    output_files: [{ path: 'out.txt', digest: { hash: 'deadbeef', size_bytes: 9 } }],
  }

  it('a LITERAL capture refuses: every returned file is a declared output', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-mat-'))
    try {
      const warns: string[] = []
      await expect(
        materialiseOutputs(stub(new Map()), req(['out.txt'], dir), result, (m) => warns.push(m)),
      ).rejects.toThrow(/out\.txt/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('CONTROL: a present blob is written, no refusal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-mat-'))
    try {
      const have = new Map([['deadbeef', new TextEncoder().encode('contents\n')]])
      await materialiseOutputs(stub(have), req(['out.txt'], dir), result, () => undefined)
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('contents\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('CONTROL: whole-tree capture only warns — the file may be incidental', async () => {
    // `*.js` has a wildcard FIRST segment, so it maps to '' and the worker
    // returns the entire working directory: inputs and undeclared siblings
    // ride along. A blob missing for one of THOSE is not this task's hole,
    // and refusing would break a build that is fine. Residual, deliberate:
    // a genuinely declared output missing under this shape still only warns.
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-mat-'))
    try {
      const warns: string[] = []
      await materialiseOutputs(stub(new Map()), req(['*.js'], dir), result, (m) => warns.push(m))
      expect(warns.some((w) => w.includes('out.txt'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
