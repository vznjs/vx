// execution.md is the trace a reader follows from argv to a task's exit,
// and by 2026-09-16 (item 296) its dispatch list named `mcp` as a core
// verb and lacked `why`, `last` and `completions`, and its essential-env
// list named eleven of seventeen POSIX names. Each list with a source is
// held to it here.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ESSENTIAL_ENV } from '../src/exec/env.js'

const pkg = path.resolve(import.meta.dir, '..')
const doc = readFileSync(path.join(pkg, 'docs', 'execution.md'), 'utf8')

describe('execution.md follows the source it traces', () => {
  it('the dispatch list names every verb cli/index.ts switches on', () => {
    const src = readFileSync(path.join(pkg, 'src', 'cli', 'index.ts'), 'utf8')
    const cases = new Set([...src.matchAll(/^\s*case '([a-z]+)':/gm)].map((m) => m[1]!))
    const m = /dispatches by subcommand \(([^;)]*)/.exec(doc)
    expect(m).not.toBeNull()
    const named = m![1]!
      .split('/')
      .map((s) => s.replace(/[^a-z]/g, ''))
      .filter((s) => s !== '')
    expect(named.sort()).toEqual([...cases].sort())
  })

  it('the essential-allowlist sentence names every POSIX name in ESSENTIAL_ENV', () => {
    const m = /\*\*Essential allowlist\*\* \(([\s\S]*?)\)\./.exec(doc)
    expect(m).not.toBeNull()
    const named = new Set([...m![1]!.matchAll(/`([A-Z_]+)`/g)].map((x) => x[1]!))
    const posix = ESSENTIAL_ENV.slice(0, ESSENTIAL_ENV.indexOf('SYSTEMROOT'))
    expect(posix.length).toBeGreaterThan(10)
    for (const name of posix) expect(named).toContain(name)
  })
})
