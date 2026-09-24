// The playground bundle the site ships is the one core's parity rows test
// (packages/vx/tests/playground-parity.unsafe.test.ts): both come from
// `buildPlayground()`, and this holds the built site's copy to a fresh
// build byte for byte, so a stale `public/`, a `build` that stopped
// depending on `build.playground`, or an astro step that rewrote the file
// fails here. It also holds what a browser needs of the file: no import
// left to resolve and no free `Bun` or `process`, which a page has not
// got (item 695).
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLANNER_FILE, buildPlayground } from '../scripts/build-playground.js'

const shipped = path.resolve(import.meta.dir, '../dist', PLANNER_FILE)

describe('the playground bundle', () => {
  it('the built site ships exactly what buildPlayground() builds', async () => {
    const fresh = await buildPlayground()
    const bytes = new Uint8Array(readFileSync(shipped))
    expect(bytes.byteLength).toBe(fresh.bytes.byteLength)
    expect(Buffer.compare(bytes, fresh.bytes)).toBe(0)
  })

  it('leaves no import to resolve and no free Bun or process for a browser', () => {
    const IMPORT = /(?:\bfrom|\bimport\()\s*["']([^"']+)["']/g
    // A free global as code follows an operator or a bracket; the shim's
    // messages ("… Bun.spawn is not available") are strings, after a space
    // or a quote.
    const FREE = /(?<=[=(,;!{}?:&|[+-])\s*(?:Bun|process)\.[A-Za-z_$][\w$]*/g
    const found = (s: string) => ({
      imports: [...s.matchAll(IMPORT)].map((m) => m[1]),
      free: [...s.matchAll(FREE)].map((m) => m[0].trim()),
    })
    // Positive first: each pattern finds the minified shape it looks for.
    expect(found('import{a}from"x";let b=Bun.file(p);f(process.env,import("y"))')).toEqual({
      imports: ['x', 'y'],
      free: ['Bun.file', 'process.env'],
    })
    const text = readFileSync(shipped, 'utf8')
    expect(found(text)).toEqual({ imports: [], free: [] })
    // The define rewrote core's globals to the shim's objects.
    expect(text.split('__vxBun').length - 1).toBeGreaterThan(10)
    expect(text.split('__vxProcess').length - 1).toBeGreaterThan(5)
  })

  it('exports planPlayground', async () => {
    const mod = (await import(shipped)) as Record<string, unknown>
    expect(Object.keys(mod)).toEqual(['planPlayground'])
    expect(typeof mod['planPlayground']).toBe('function')
  })
})
