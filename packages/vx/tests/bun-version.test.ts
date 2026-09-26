// The runtime floor is stated in `engines` and read by nobody at run time, so
// a `bun src/bin.ts` below it starts fine and answers wrongly (STATUS item
// 366 measured which answers: a truncated JSON write, no usage numbers, a
// config syntax error arriving as an internal error). `bin.ts` warns now.
//
// The entry case asserts the behaviour AGAINST THE RUNNING BUN rather than a
// fixed expectation, so it is the same claim on a conforming runtime and on
// one below the floor — which is the only way a guard about the runtime can
// be tested on both.
import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isUnsupportedBun, MIN_BUN, unsupportedBunMessage } from '../src/util/index.js'
import { collectInfo } from '../src/orchestrator/index.js'

describe('isUnsupportedBun', () => {
  it('compares major, minor and patch in that order', () => {
    const verdicts = Object.fromEntries(
      ['0.9.9', '1.3.11', '1.3.99', '1.4.0', '1.4.2', '1.5.0', '2.0.0'].map((v) => [
        v,
        isUnsupportedBun(v),
      ]),
    )
    expect(verdicts).toEqual({
      '0.9.9': true,
      '1.3.11': true,
      '1.3.99': true,
      '1.4.0': false,
      '1.4.2': false,
      '1.5.0': false,
      '2.0.0': false,
    })
  })

  it('reads a canary suffix as its release, and junk as 0', () => {
    // `Bun.version` on a canary is `1.4.2-canary.20260919`; parseInt stops at
    // the dash, so the build is judged by its release. A string that parses to
    // nothing is treated as ancient rather than waved through.
    expect(isUnsupportedBun('1.4.2-canary.20260919')).toBe(false)
    expect(isUnsupportedBun('1.3.11-canary.1')).toBe(true)
    expect(isUnsupportedBun('not-a-version')).toBe(true)
  })

  it('the message names the floor and what is running', () => {
    const m = unsupportedBunMessage('1.3.11')
    expect(m).toContain(MIN_BUN.join('.'))
    expect(m).toContain('1.3.11')
    // The point of the line: below the floor vx does not fail, it lies.
    expect(m).toContain('answers wrongly')
  })
})

describe('the doctor reports the runtime verdict, and nothing else does', () => {
  it("`vx info`'s bun row says so exactly when this Bun is below the floor", async () => {
    // A fixture workspace with its own cache dir, not this repo: a sandboxed
    // shard sees the checkout read-only, and `collectInfo` opens a cache
    // before it reports anything (the gate caught exactly that).
    const root = mkdtempSync(path.join(tmpdir(), 'vx-bunver-'))
    await Bun.write(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    const facts = await collectInfo(root, { cacheDir: path.join(root, 'cache') }).finally(() =>
      rmSync(root, { recursive: true, force: true }),
    )
    // `bun` stays the bare version — `--format json` is a machine surface and
    // show-info.test.ts holds it to `Bun.version` exactly. The verdict is its
    // own boolean, and the prose lives only in the rendered row.
    expect({ supported: facts.bunSupported, version: facts.bun }).toEqual({
      supported: !isUnsupportedBun(Bun.version),
      version: Bun.version,
    })
  }, 30_000)

  it('a clean invocation still writes nothing to stderr', async () => {
    // The first draft of this guard warned from `bin.ts` on every run. It
    // cost 19 tests, all asserting the same real property: a successful vx
    // command says nothing on stderr. The diagnostic belongs where
    // diagnostics are read, not on every invocation.
    const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    const proc = Bun.spawn(['bun', bin, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect({ err, answered: out.trim().startsWith('vx '), code }).toEqual({
      err: '',
      answered: true,
      code: 0,
    })
  }, 30_000)
})
