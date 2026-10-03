// Next's inferred build outputs `{projectRoot}/.next/!(cache)/**/*` and
// `{projectRoot}/.next/!(cache)`: everything but the build cache. vx's
// glob has no extglob, so the outputs were written as a literal `!(cache)`
// dir: the build saved nothing and a cache hit restored no `.next`. A
// whole-segment `!(…)` is `*` with a `!` output taking the names back.

import { describe, expect, it } from 'bun:test'
import { mapNxOutputs } from '../src/nx/nx-outputs.js'

const map = (outputs: string[]) => {
  const todos: string[] = []
  return { ...mapNxOutputs(outputs, {}, 'apps/web', 'web', todos), todos }
}

describe('extglob outputs', () => {
  it("Next's build: all of .next but its cache", () => {
    const r = map(['{projectRoot}/.next/!(cache)/**/*', '{projectRoot}/.next/!(cache)'])
    expect(r).toEqual({
      outFiles: ['.next/*/**/*', '!.next/cache/**/*', '.next/*', '!.next/cache'],
      wsOutFiles: [],
      todos: [],
    })
    // What the written globs keep, as vx's glob reads them.
    const pos = r.outFiles.filter((g) => !g.startsWith('!')).map((g) => new Bun.Glob(g))
    const neg = r.outFiles.filter((g) => g.startsWith('!')).map((g) => new Bun.Glob(g.slice(1)))
    const keeps = (p: string) => pos.some((g) => g.match(p)) && !neg.some((g) => g.match(p))
    expect(
      ['.next/BUILD_ID', '.next/server/app.js', '.next/cache', '.next/cache/a/b'].map(keeps),
    ).toEqual([true, true, false, false])
  })

  it('several names, at the workspace root', () => {
    expect(map(['{workspaceRoot}/dist/!(tmp|cache)/**']).wsOutFiles).toEqual([
      'dist/*/**',
      '!dist/{tmp,cache}/**',
    ])
  })

  it('other minimatch forms in vx grammar; one with no spelling is dropped', () => {
    const r = map(['{projectRoot}/dist/*.@(js|map)', '!{projectRoot}/dist/!(keep)'])
    expect(r.outFiles).toEqual(['dist/*.{js,map}'])
    expect(r.todos).toEqual([
      'output "!{projectRoot}/dist/!(keep)" has a glob form vx cannot spell — dropped',
    ])
  })
})
