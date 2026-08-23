// Unit coverage for the executor's pure logic: glob → output-path mapping and
// placement acceptance. The gRPC-touching half lives in reapi-e2e.test.ts.

import { describe, expect, it } from 'bun:test'
import { acceptsTask, globToOutputPath, outputPathSets } from '../src/executor.js'
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
