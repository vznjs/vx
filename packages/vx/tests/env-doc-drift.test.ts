// docs/cli.md § Environment variables is the one place a user finds what
// `VX_*` means. Nothing tied it to the source until item 614: two of the
// six variables core read were documented nowhere a user looks
// (`VX_WATCH_POLL` in two history files, `VX_CONFIG_WORKER_TIMEOUT_MS` in
// a code comment). Same shape as cli-doc-drift's Flags table: the set the
// source reads against the set the table names, one assertion, both
// directions, so neither an undocumented variable nor a documented ghost
// lands quietly. The source of truth is the `process.env` reads themselves,
// not a list a test could agree with.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')

function readInSource(): Set<string> {
  const ls = Bun.spawnSync(['git', 'ls-files', '-z', 'src'], { cwd: pkg })
  const sources = ls.stdout
    .toString()
    .split('\0')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(path.join(pkg, f), 'utf8'))
  // A read through a named constant (`process.env[VX_RUN_TASK_ENV]`,
  // exec/env.ts) is a read of the name the constant holds.
  const constants = new Map<string, string>()
  for (const src of sources)
    for (const m of src.matchAll(/const (\w+_ENV) = '(VX_[A-Z0-9_]+)'/g))
      constants.set(m[1]!, m[2]!)
  const names = new Set<string>()
  for (const src of sources) {
    for (const m of src.matchAll(/process\.env(?:\.|\[')(VX_[A-Z0-9_]+)/g)) names.add(m[1]!)
    for (const m of src.matchAll(/process\.env\[(\w+_ENV)\]/g)) {
      const name = constants.get(m[1]!)
      expect({ constant: m[1], resolved: name !== undefined }).toEqual({
        constant: m[1],
        resolved: true,
      })
      names.add(name!)
    }
  }
  return names
}

function documented(): Set<string> {
  const doc = readFileSync(path.join(pkg, 'docs', 'cli.md'), 'utf8')
  const start = doc.indexOf('## Environment variables vx reads')
  expect(start).toBeGreaterThan(-1)
  const names = new Set<string>()
  for (const line of doc.slice(start).split('\n')) {
    // A row may name two variables set and read together.
    const cell = /^\| ((?:`VX_[A-Z0-9_]+`(?:, )?)+) /.exec(line)
    if (cell !== null) {
      for (const m of cell[1]!.matchAll(/`(VX_[A-Z0-9_]+)`/g)) names.add(m[1]!)
      continue
    }
    if (names.size > 0) break
  }
  return names
}

describe('docs/cli.md § Environment variables vx reads matches what core reads', () => {
  it('names every VX_ variable the source reads, and no others', () => {
    const source = readInSource()
    expect(source.size).toBeGreaterThan(4)
    expect([...documented()].sort()).toEqual([...source].sort())
  })
})
