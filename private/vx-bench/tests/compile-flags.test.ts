import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { vxCompileFlags } from '../compile-entries.js'

it("times vx compiled with the release's flags", () => {
  // The bench's own copy lacked this one: its vx loaded `.env` at start.
  expect(vxCompileFlags()).toEqual(
    expect.arrayContaining(['--no-compile-autoload-dotenv', '--minify', '--bytecode']),
  )
  for (const file of ['compare.ts', 'pr-bench.ts', 'pr-bench-base.ts', 'real/nightly.ts']) {
    const src = readFileSync(path.join(import.meta.dir, '..', file), 'utf8')
    expect(src).toMatch(/'--compile',\s*\.\.\.vxCompileFlags\(\),/)
  }
})

it('refuses a release command it cannot read', () => {
  expect(() => vxCompileFlags('command: `bun build src/bin.ts`')).toThrow(/no compile\.bun/)
  expect(() =>
    vxCompileFlags('command: `bun build --compile --minify ${X} --target=bun-linux-x64`'),
  ).toThrow(/cannot read the flags \$\{X\}/)
})
