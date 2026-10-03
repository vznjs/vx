// Module pages a fix left behind: the commit updated cli.md or caching.md
// and the page for the file it changed kept the old claim. Each row holds
// one page to what its code now does.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { formatRunSummary } from '../src/orchestrator/summary.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'

const DOCS = path.resolve(import.meta.dir, '..', 'docs')

/** The paragraphs and list items of a page holding `needle`, flattened. */
function blocks(rel: string, needle: string): string[] {
  return readFileSync(path.join(DOCS, rel), 'utf8')
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
    .map((b) => b.split(/\s+/).join(' '))
    .filter((b) => b.includes(needle))
}

describe("summary.md's result row says what the rate counts", () => {
  it('a skipped task is out of the rate, and the page says so', () => {
    // #2212: one hit, one miss and one skip read "1 cached (33%)"; the skip never asked.
    const node = (id: string): TaskNode =>
      ({
        id,
        projectName: 'a',
        taskName: id.split('#')[1],
        config: {
          exec: { command: 'x' },
          cache: { inputs: { files: [] }, outputs: { files: [] } },
        },
      }) as unknown as TaskNode
    const outcomes: TaskOutcome[] = [
      { node: node('a#hit'), status: 'cache-hit', exitCode: 0, durationMs: 1, restored: false },
      { node: node('a#ran'), status: 'failed', exitCode: 1, durationMs: 5 },
      { node: node('a#after'), status: 'skipped', exitCode: 0, durationMs: 0, blockedBy: 'a#ran' },
    ]
    const result = formatRunSummary(
      outcomes,
      10,
      { enabled: false },
      { version: '0.0.0', packageCount: 1, remoteCacheEnabled: false },
    ).find((l) => l.includes('result'))!
    expect(result).toContain('1 cached (50%)')
    const para = blocks('modules/summary.md', 'cached (P%)')
    expect(para.length).toBe(1)
    expect(para[0]).toMatch(/skipped task never did/)
  })
})

describe('every page explaining the blob-size check names what it cannot see', () => {
  it.each(['caching.md', 'modules/git-inputs.md'])('%s', (rel) => {
    // #2226: a filter that keeps the size, removed after an add, passes.
    const explained = blocks(rel, 'blob').filter((b) =>
      /another size is dropped|The check is by size/.test(b),
    )
    expect(explained.length).toBeGreaterThan(0)
    for (const b of explained) expect(b).toMatch(/(?:keeps|kept) the size/)
  })
})

const SRC = path.resolve(import.meta.dir, '..', 'src')
const src = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8')
const page = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), 'utf8').split(/\s+/).join(' ')

// Each row reads the fact from the source, then holds the page to it.
describe('module pages state what their file does since the fix', () => {
  it('bin.md: a lone --version is answered before the dispatcher loads (#1961)', () => {
    expect(src('bin.ts')).toMatch(/argv\[0\] === '--version'/)
    expect(page('modules/bin.md')).toMatch(/lone `--version`.{0,80}answered.{0,80}before/)
  })

  it('metrics.md: an unchanged key names the continue-taint before --no-cache (#1928)', () => {
    expect(src('orchestrator/metrics.ts')).toContain('each ran beside a failed task')
    const why = blocks('modules/metrics.md', '`whyDidThisRerun` compares')
    expect(why.length).toBe(1)
    expect(why[0]).toMatch(/beside a failed task.*Only when none applies/)
  })

  it('cli-watch.md: only the tasks the watch reaches keep a path from being dropped', () => {
    expect(src('cli/watch-set.ts')).toContain('function reachableNames(')
    const rule = blocks('modules/cli-watch.md', 'item 946')
    expect(rule.length).toBe(1)
    expect(rule[0]).toMatch(/a task the watch reaches declares as an input/)
    expect(page('modules/cli-watch.md')).toContain('`discoverCliProjects`')
    expect(src('cli/watch.ts')).not.toMatch(/\blistProjects\(/)
  })

  it('package-graph.md: the first transitiveDeps asks are a search, not the bitsets (#2323)', () => {
    const n = /const EARLY_SEARCHES = (\d+)/.exec(src('workspace/package-graph.ts'))?.[1]
    expect(n).toBeDefined()
    const rule = blocks('modules/package-graph.md', 'built on the FIRST query')
    expect(rule.length).toBe(1)
    expect(rule[0]).toContain(`\`transitiveDeps\` answers its first ${n} asks by a search`)
    expect(rule[0]).toMatch(
      /Past those, and for every `transitiveDependents` ask, a closure is a bitset/,
    )
  })

  it('affected.md: a resolved base skips the verify and the merge-base spawn (#2288)', () => {
    const src_ = src('workspace/affected.ts')
    expect(src_).toContain('if (resolvedRefs.has(`${workspaceRoot}\\0${ref}`)) return')
    expect(src_).toContain('const HEAD_ANCESTOR = ')
    const verify = blocks('modules/affected.md', '`verifyRef(workspaceRoot, since)`')
    expect(verify.length).toBe(1)
    expect(verify[0]).toContain('is not asked again (#2288)')
    const diff = blocks('modules/affected.md', '`git diff --name-only <merge-base(since, HEAD)>`')
    expect(diff.length).toBe(1)
    expect(diff[0]).toContain('no `git merge-base` spawns (#2288)')
    expect(diff[0]).toContain('committed, staged and unstaged changes')
  })

  it('orchestrator.md: a crashed server is named mid-run and after the summary (#2152)', () => {
    const run = src('orchestrator/run.ts')
    expect(run).toContain('exited with code ${code} while the run went on`')
    expect(run).toContain('exited with code ${code} before the run stopped it`')
    const page_ = page('modules/orchestrator.md').replace(/\s+/g, ' ')
    expect(page_).toContain('`vx: <id> exited with code <n> before the run stopped it`')
    expect(page_).toContain('`vx: <id> exited with code <n> while the run went on`')
  })

  it('orchestrator.md: a held server that dies after the run is named (#2442)', () => {
    expect(src('orchestrator/run.ts')).toContain(
      'if (!stopping && code !== 0) log.status(`vx: ${n.id} exited with code ${code}`)',
    )
    const held = blocks('modules/orchestrator.md', 'RunOptions.holdPersistent')
    expect(held.length).toBe(1)
    expect(held[0]).toContain('One that dies on its own after that is named')
  })

  it("logger.md: a kept server's output streams under its id after the summary (#2054)", () => {
    expect(src('orchestrator/logger.ts')).toContain('formatKeptLines(')
    expect(page('modules/logger.md')).toMatch(
      /streams below the summary a line at a time under its id/,
    )
  })
})

// J2-39: eight signatures on the module pages lacked a parameter the
// source takes (deniedCalls' cwd and reads, migrateScripts' outside, …).
describe('a module page lists every parameter its function takes', () => {
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  /** Top-level parameters of the list at `at` (generics skipped), or null. */
  const arity = (text: string, at: number): number | null => {
    let i = at
    if (text[i] === '<') {
      for (let d = 0; i < text.length; i++) {
        if (text[i] === '<') d++
        else if (text[i] === '>' && text[i - 1] !== '=' && --d === 0) {
          i++
          break
        }
      }
    }
    if (text[i] !== '(') return null
    let depth = 0
    let commas = 0
    let any = false
    for (i++; i < text.length; i++) {
      const c = text[i]!
      if ('([{<'.includes(c)) depth++
      else if (')]}'.includes(c) || (c === '>' && text[i - 1] !== '=')) {
        if (depth === 0 && c === ')') return any ? commas + 1 : 0
        depth--
      } else if (c === ',' && depth === 0) {
        if (/^\s*\)/.test(text.slice(i + 1))) return commas + 1
        commas++
      } else if (!/\s/.test(c)) any = true
    }
    return null
  }
  const exported = (text: string): [string, number | null][] =>
    [...strip(text).matchAll(/export (?:async )?function (\w+)/g)].map((m) => [
      m[1]!,
      arity(strip(text), m.index! + m[0].length),
    ])

  it('each documented export function has a source arity to match', () => {
    const counts = new Map<string, Set<number | null>>()
    for (const rel of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue
      for (const [name, n] of exported(readFileSync(path.join(SRC, rel), 'utf8'))) {
        counts.set(name, (counts.get(name) ?? new Set()).add(n))
      }
    }
    const off: string[] = []
    let seen = 0
    for (const f of readdirSync(path.join(DOCS, 'modules'))) {
      for (const [name, n] of exported(readFileSync(path.join(DOCS, 'modules', f), 'utf8'))) {
        const src = counts.get(name)
        if (src === undefined) continue
        seen++
        if (!src.has(n)) off.push(`${f}: ${name} lists ${n}, source takes ${[...src].join('/')}`)
      }
    }
    expect(seen).toBeGreaterThan(200)
    expect(off).toEqual([])
  })
})

// J2-40: interfaces on the module pages had fallen behind their source —
// CacheLayer listed 9 of its 25 members, plus one only `Cache` has.
describe('a module page lists exactly the fields its interface has', () => {
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/(?! …)[^\n]*/g, '')
  /** Each `export interface` → its top-level member names; null when abridged (`// …`). */
  const interfaces = (text: string): [string, Set<string> | null][] =>
    [...text.matchAll(/export interface (\w+)(?:<[^{]*>)?(?: extends [^{]+)? \{/g)].map((m) => {
      let body = ''
      for (let i = m.index! + m[0].length, d = 1; i < text.length; i++) {
        const c = text[i]!
        if (c === '{') d++
        else if (c === '}' && --d === 0) break
        body += d === 1 || c === '\n' ? c : ' '
      }
      if (body.includes('// …')) return [m[1]!, null]
      const names = body.matchAll(/^\s*(?:readonly\s+)?['"]?([\w$]+)['"]?\??\s*[:(<]/gm)
      return [m[1]!, new Set([...names].map((n) => n[1]!))]
    })
  const sorted = (s: Set<string>): string => [...s].sort().join(',')

  it('each documented interface matches a source one member for member', () => {
    const sources = new Map<string, string[]>()
    for (const rel of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue
      for (const [name, fields] of interfaces(strip(readFileSync(path.join(SRC, rel), 'utf8')))) {
        if (fields) sources.set(name, [...(sources.get(name) ?? []), sorted(fields)])
      }
    }
    const off: string[] = []
    let seen = 0
    for (const f of readdirSync(path.join(DOCS, 'modules'))) {
      const text = strip(readFileSync(path.join(DOCS, 'modules', f), 'utf8'))
      for (const [name, fields] of interfaces(text)) {
        const src = sources.get(name)
        if (src === undefined || fields === null) continue
        seen++
        if (!src.includes(sorted(fields))) off.push(`${f}: ${name} {${sorted(fields)}}`)
      }
    }
    expect(seen).toBeGreaterThan(100)
    expect(off).toEqual([])
  })
})

// J2-43: #2546 made `vx init` keep each config a member already has and
// write the rest; migration.md still said any existing config aborts the
// whole run.
describe("migration.md's overwrite guard says vx init keeps a member's config", () => {
  it('the page names the kept list the report prints', () => {
    expect(src('workspace/migration.ts')).toContain("'kept (each already has a vx config):'")
    const guard = blocks('modules/migration.md', 'Nothing is overwritten without')
    expect(guard).toHaveLength(1)
    expect(guard[0]).toContain(
      'Under `vx init` (`init`) a project that already has a config keeps it',
    )
    expect(guard[0]).toContain('under `kept`')
  })
})

// J2-44: eighteen names the module indexes export (`SchemaReset`,
// `formatRunReportMarkdown`, the plugin installer's types, …) were named
// in code on no module page. Each module's contract is its index.
describe('every name a module index exports is in code on a module page', () => {
  it('src/<module>/index.ts names each appear in a code span or block', () => {
    const pages = readdirSync(path.join(DOCS, 'modules'))
      .map((f) => readFileSync(path.join(DOCS, 'modules', f), 'utf8'))
      .join('\n')
    const fenced = pages.split('```').filter((_, i) => i % 2 === 1)
    const spans = pages
      .split('```')
      .filter((_, i) => i % 2 === 0)
      .flatMap((t) => t.match(/`[^`]+`/g) ?? [])
    const code = [...fenced, ...spans].join('\n')
    const missing: string[] = []
    let seen = 0
    for (const mod of readdirSync(SRC)) {
      let text: string
      try {
        text = readFileSync(path.join(SRC, mod, 'index.ts'), 'utf8')
      } catch {
        continue
      }
      text = text.replace(/\/\/[^\n]*/g, '')
      for (const list of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
        for (const part of list[1]!.split(',')) {
          const name = part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)
            .pop()!
            .trim()
          if (name === '') continue
          seen++
          if (!new RegExp(`\\b${name}\\b`).test(code)) missing.push(`${mod}: ${name}`)
        }
      }
    }
    expect(seen).toBeGreaterThan(300)
    expect(missing).toEqual([])
  })
})

// J2-47: upgrade.md said compiled-binary detection uses NOT
// `import.meta.path`; the check ORs it in last.
describe("upgrade.md's detection invariant names every path it checks", () => {
  it('import.meta.path is the last fallback, and the page says so', () => {
    const check = src('cli/upgrade.ts').match(/function isCompiledBinary\(\)[^}]*\}/)![0]
    expect(check).toContain('isBunfsPath(Bun.main)')
    expect(check).toContain('isBunfsPath(import.meta.path)')
    const rule = blocks('modules/upgrade.md', 'Compiled-binary detection')
    expect(rule).toHaveLength(1)
    expect(rule[0]).not.toContain('NOT `import.meta.path`')
    expect(rule[0]).toContain('`import.meta.path` is only a last fallback')
  })
})

// J2-48: plugin.md listed the stages whose throw fails the run naming
// the plugin as config, project, graph, key and schedule; `discover` and
// `fingerprint` go through the same guard (`safe` in plugin-host.ts).
describe("plugin.md's fail-the-run list is the hooks plugin-host guards", () => {
  it('each hook passed to safe() is named in the bullet', () => {
    const hooks = [...src('orchestrator/plugin-host.ts').matchAll(/safe\(plugin, '([a-z]+)'/g)].map(
      (m) => m[1]!,
    )
    expect(new Set(hooks).size).toBeGreaterThanOrEqual(9)
    const rule = blocks('modules/plugin.md', 'A throw in `setup`')
    expect(rule).toHaveLength(1)
    expect([...new Set(hooks)].filter((h) => !rule[0]!.includes(`\`${h}\``))).toEqual([])
  })
})
