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

  // Step 11 named `git ls-files -s --others` and one `git status`. The
  // enumeration has spawned four commands since the OID work, and
  // `--others` is the one it deliberately does NOT pass — `status -uall`
  // answers untracked, and asking git for it again walked the same tree a
  // second time. `runGitLsFiles` still passes `--others`, which is why the
  // page could look right: that function is the FALLBACK re-spawn for an
  // invalidated partition, not the bulk populate (item 388, 2026-09-19).
  it('the bulk-populate step names every command startGitEnumeration spawns', () => {
    const src = readFileSync(path.join(pkg, 'src', 'cache', 'git-inputs.ts'), 'utf8')
    const fn = /export async function startGitEnumeration\b[\s\S]*?\n\}/.exec(src)
    expect(fn).not.toBeNull()
    const spawned = [...fn![0]!.matchAll(/spawnGit\(\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]!)
    // The rev-parse is asked through `repoFacts`, the memo the file hasher
    // shares: its command is read from there.
    expect(fn![0]!).toContain('repoFacts(workspaceRoot)')
    const facts = /export function repoFacts\b[\s\S]*?\n\}/.exec(src)
    const revParse = /executablePath\('git'\),\s*'([a-z-]+)'/.exec(facts?.[0] ?? '')
    spawned.push(revParse![1]!)
    expect(spawned.sort()).toEqual(['config', 'ls-files', 'rev-parse', 'status'])

    const step = /11\. Bulk git populate([\s\S]*?)\n \u251c/.exec(doc)
    expect(step).not.toBeNull()
    const text = step![1]!
    expect(spawned.filter((c) => !text.includes(c))).toEqual([])
    // The page must say what it is NOT, or the next reader re-adds it.
    expect(text).toContain('`ls-files --others` is NOT among them')
  })

  // The step-4 list read as the whole call and omitted `pluginParts` — the
  // one argument a plugin author comes to this page for, and the `key`
  // seam is core's extensibility story. Held to `CacheKeyInput` minus the
  // plumbing named here, so a new field is a decision in this test rather
  // than a silent gap on the page (item 388, 2026-09-19).
  it('the cache.key list names every key-bearing field of CacheKeyInput', () => {
    const src = readFileSync(path.join(pkg, 'src', 'cache', 'layer.ts'), 'utf8')
    const iface = /export interface CacheKeyInput \{([\s\S]*?)\n\}/.exec(src)
    expect(iface).not.toBeNull()
    const fields = [...iface![1]!.matchAll(/^  ([a-zA-Z]+)\??:/gm)].map((m) => m[1]!)
    // Not key material: `workspaceRoot` only relativizes the input paths,
    // `fileHashes` is where a file's OID comes FROM, `upstreamIds` and
    // `upstreamGraft` name and place upstream work without being folded,
    // and `captureInto` is the `vx why` capture sink.
    const PLUMBING = ['workspaceRoot', 'fileHashes', 'upstreamIds', 'upstreamGraft', 'captureInto']
    const folded = fields.filter((f) => !PLUMBING.includes(f))
    expect(folded.length).toBeGreaterThan(9)

    const call = /cache\.key\(\{([\s\S]*?)\}\)/.exec(doc)
    expect(call).not.toBeNull()
    const named = call![1]!
      .split(',')
      .map((x) => x.replace(/[^a-zA-Z]/g, ''))
      .filter((x) => x !== '')
    expect(folded.filter((f) => !named.includes(f)).sort()).toEqual([])
    expect(named.filter((f) => !folded.includes(f)).sort()).toEqual([])
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
