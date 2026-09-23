// The README names every environment variable the plugin reads, and no
// other: `VX_REAPI_EXECUTE` was read and named nowhere a user looks until
// item 618. The set the source reads (both spellings) against the set the
// README names, one assertion, both directions — the shape of core's
// env-doc pin.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('README names every VX_ variable the plugin reads', () => {
  it('the two sets are equal', () => {
    const read = new Set<string>()
    for (const f of sources(path.join(pkg, 'src'))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/(?:process|Bun)\.env(?:\.|\[')(VX_[A-Z0-9_]+)/g))
        read.add(m[1]!)
    }
    expect(read.size).toBeGreaterThan(1)
    const readme = readFileSync(path.join(pkg, 'README.md'), 'utf8')
    // The suite's own gates (`VX_REAPI_TEST_ENDPOINT`, `VX_REQUIRE_REAPI`) are
    // the README's too, but tests read them, not the plugin.
    const named = new Set(
      [...readme.matchAll(/`(VX_REAPI_[A-Z0-9_]+)(?:=[^`]*)?`/g)]
        .map((m) => m[1]!)
        .filter((n) => n !== 'VX_REAPI_TEST_ENDPOINT'),
    )
    expect([...named].sort()).toEqual([...read].sort())
  })
})
