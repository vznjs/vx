// What buildPlayground() makes, from a fresh build (item 838): how each
// platform specifier the planner's import graph names is met, who names
// it, and that the stubs shake out of a minified file. Core's parity rows
// prove the bundle plans what the CLI plans; they held 6 of 15 mutations
// of the build, and these hold the rest that can happen.
import { beforeAll, describe, expect, it } from 'bun:test'
import { buildPlayground, type PlaygroundBuild } from '../scripts/build-playground.js'

let build: PlaygroundBuild
let text: string
beforeAll(async () => {
  build = await buildPlayground()
  text = new TextDecoder().decode(build.bytes)
}, 60_000)

describe('the playground build', () => {
  it('meets each platform specifier as the shim, the polyfill or a stub', () => {
    const treatments = Object.fromEntries(
      [...build.specifiers].map(([spec, { treatment }]) => [spec, treatment]),
    )
    expect(treatments).toEqual({
      'node:fs': 'shim',
      'node:fs/promises': 'shim',
      'bun:sqlite': 'shim',
      'node:path': 'polyfill',
      'node:os': 'stub',
      'node:module': 'stub',
      '@anthropic-ai/sandbox-runtime': 'stub',
    })
  })

  it('names who imports each, relative to packages/', () => {
    for (const [spec, { importers }] of build.specifiers) {
      expect({ spec, some: importers.size > 0 }).toEqual({ spec, some: true })
      for (const f of importers) expect(f.startsWith('vx/src/')).toBe(true)
    }
    expect([...build.specifiers.get('bun:sqlite')!.importers]).toEqual(['vx/src/cache/cache.ts'])
  })

  it('shakes out every stub export the plan never reads, in a minified file', () => {
    // A stub's export is `unavailable("<specifier> <name>")`; one the plan
    // reads would leave its name here.
    const STUB_NAME =
      /"(?:node:[a-z/]+|bun:[a-z]+|@anthropic-ai\/sandbox-runtime) [A-Za-z_$][\w$]*"/g
    expect('x=u("node:os cpus"),y=u("node:module _cache")'.match(STUB_NAME)).toHaveLength(2)
    expect(text.match(STUB_NAME)).toBeNull()
    expect(text.split('\n').length).toBeLessThan(200)
  })
})
