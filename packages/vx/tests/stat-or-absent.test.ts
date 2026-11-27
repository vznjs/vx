// Bun's `throwIfNoEntry: false` passes over ENOENT alone, where Node's
// passes over ENOTDIR too: a path under a FILE threw. `--profile=<file>/p.json`
// died "this is a bug in vx", and an output literal under a file a past run
// left failed its task "output clean failed" (2026-11-27). Every stat in
// `src/` that may find nothing goes through `lstatOrAbsent` / `statOrAbsent`.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lstatOrAbsent, statOrAbsent } from '../src/util/index.js'

const SRC = path.resolve(import.meta.dir, '..', 'src')

describe('a stat under a file is absent', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vx-stat-absent-'))
    writeFileSync(path.join(dir, 'f'), 'x')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('answers undefined for ENOENT and ENOTDIR, a stat otherwise', () => {
    expect([
      lstatOrAbsent(path.join(dir, 'f', 'p.json')),
      statOrAbsent(path.join(dir, 'f', 'p.json')),
      lstatOrAbsent(path.join(dir, 'none')),
      statOrAbsent(path.join(dir, 'f'))?.isFile(),
    ]).toEqual([undefined, undefined, undefined, true])
  })

  it('src/ asks Bun for throwIfNoEntry nowhere else', () => {
    const found: string[] = []
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC })) {
      const code = readFileSync(path.join(SRC, rel), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      for (const l of code) if (l.includes('throwIfNoEntry')) found.push(rel)
    }
    expect(found.sort()).toEqual(['util/real-path.ts', 'util/real-path.ts'])
  })
})
