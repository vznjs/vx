// A module page's `Public surface` block declares an interface's fields as
// well as its name; the surface law (module-surface-drift.test.ts) holds
// the names only. scheduler.md's TaskOutcome had twelve of the interface's
// twenty-three fields, inputs.md's ResolveInputsArgs six of eleven and
// cli-cache.md's PruneArgs three of five (item 314, 2026-09-16). Here the
// block's field list is the source's, and a quoted constant or regex is
// the source's too.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8')

/** Top-level field names of `interface <name> {…}` in a doc block or a source file. */
function interfaceFields(text: string, name: string): string[] {
  const open = `interface ${name} {`
  const start = text.indexOf(open)
  expect(start).toBeGreaterThan(-1)
  const out: string[] = []
  let depth = 0
  let inComment = false
  for (const raw of text.slice(start + open.length).split('\n')) {
    let line = raw
    if (inComment) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      inComment = false
      line = line.slice(end + 2)
    }
    // Comments left to right: a `//` inside a block (`/** as \`// TODO\` */`)
    // is not a line comment, and a `/*` inside a line comment (`// (\`./x/*\`)`)
    // does not open a block — whichever opener comes first wins.
    for (;;) {
      const lc = line.indexOf('//')
      const bc = line.indexOf('/*')
      if (bc !== -1 && (lc === -1 || bc < lc)) {
        const end = line.indexOf('*/', bc + 2)
        if (end === -1) {
          inComment = true
          line = line.slice(0, bc)
          break
        }
        line = line.slice(0, bc) + line.slice(end + 2)
        continue
      }
      if (lc !== -1) line = line.slice(0, lc)
      break
    }
    if (depth === 0) {
      const m = /^\s*(\w+)\??:/.exec(line)
      if (m) out.push(m[1]!)
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') {
        if (depth === 0) return out
        depth--
      }
    }
  }
  return out
}

const SHAPES: ReadonlyArray<[page: string, source: string, name: string]> = [
  ['scheduler', 'graph/scheduler.ts', 'TaskOutcome'],
  ['scheduler', 'graph/scheduler.ts', 'ScheduleOptions'],
  ['inputs', 'cache/inputs.ts', 'ResolvedInputs'],
  ['inputs', 'cache/inputs.ts', 'ResolveInputsArgs'],
  ['cli-cache', 'cli/cache.ts', 'PruneArgs'],
  ['task-hash', 'orchestrator/task-hash.ts', 'HashCache'],
  ['task-hash', 'orchestrator/task-hash.ts', 'ComputeHashArgs'],
  ['prepare', 'orchestrator/prepare.ts', 'PreparedRun'],
  ['cli-run', 'cli/run.ts', 'RunArgs'],
  ['summary', 'orchestrator/summary.ts', 'SummaryStats'],
  ['summary', 'orchestrator/summary.ts', 'RunContext'],
  ['filter', 'workspace/filter.ts', 'ParsedFilter'],
  ['filter', 'workspace/filter.ts', 'ApplyFiltersOptions'],
  ['env', 'exec/env.ts', 'BuildEnvOptions'],
  ['deferred-outputs', 'orchestrator/deferred-outputs.ts', 'DeferredEntry'],
  ['deferred-outputs', 'orchestrator/deferred-outputs.ts', 'DeferredOutputsArgs'],
  ['migration', 'workspace/migration.ts', 'MigrationPlan'],
  ['migration', 'workspace/migration.ts', 'GeneratedProject'],
  ['migration', 'workspace/migration.ts', 'GeneratedTask'],
  ['migration', 'workspace/migration.ts', 'ApplyMigrationArgs'],
  ['remote-prefetch', 'orchestrator/remote-prefetch.ts', 'PrefetchArgs'],
  ['history', 'orchestrator/history.ts', 'TaskHistory'],
  ['run-context', 'orchestrator/run-context.ts', 'GitContext'],
  ['run-context', 'orchestrator/run-context.ts', 'CiContext'],
  ['run-context', 'orchestrator/run-context.ts', 'HostContext'],
  ['config-cache', 'workspace/config-cache.ts', 'ConfigEvalKeyResult'],
  ['config-cache', 'workspace/config-cache.ts', 'ConfigEvalKeyArgs'],
  ['placement', 'orchestrator/placement.ts', 'Placements'],
  ['hit-restore', 'orchestrator/hit-restore.ts', 'RestoreHitArgs'],
  ['miss-save', 'orchestrator/miss-save.ts', 'OutputDirSnapshot'],
  ['miss-save', 'orchestrator/miss-save.ts', 'SaveMissArgs'],
  ['options', 'orchestrator/options.ts', 'RunOptions'],
  ['options', 'orchestrator/options.ts', 'RunSummary'],
  ['lockfile', 'workspace/lockfile.ts', 'LockfileEntry'],
  ['lockfile', 'workspace/lockfile.ts', 'Lockfile'],
  ['plugin-commands', 'cli/plugin-commands.ts', 'ResolvedPluginCommand'],
  ['plugin-commands', 'cli/plugin-commands.ts', 'UnresolvedPluginCommand'],
]

describe('a module page declares an interface with the fields the module has', () => {
  for (const [page, source, name] of SHAPES) {
    it(`docs/modules/${page}.md's ${name} is src/${source}'s`, () => {
      const doc = interfaceFields(read(`docs/modules/${page}.md`), name)
      const src = interfaceFields(read(`src/${source}`), name)
      expect(src.length).toBeGreaterThan(0)
      expect(doc).toEqual(src)
    })
  }
})

describe('a module page quotes a constant or a regex the module has', () => {
  it("inputs.md's always-ignored list is ALWAYS_IGNORE", () => {
    const src = read('src/cache/inputs.ts')
    const arr = /const ALWAYS_IGNORE = \[([\s\S]*?)\n\]/.exec(src)
    expect(arr).not.toBeNull()
    const constant = [...arr![1]!.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    const doc = read('docs/modules/inputs.md')
    const rule = /\*\*Always-ignored\*\* — hard-coded([\s\S]*?)— applied/.exec(doc)
    expect(rule).not.toBeNull()
    expect([...rule![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)).toEqual(constant)
  })

  it("env.md's two allowlist paragraphs are ESSENTIAL_ENV, split where Windows begins", () => {
    const src = read('src/exec/env.ts')
    const arr = /export const ESSENTIAL_ENV: readonly string\[\] = \[([\s\S]*?)\n\]/.exec(src)
    expect(arr).not.toBeNull()
    const constant = [...arr![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    const doc = read('docs/modules/env.md')
    const posix = /POSIX: ([\s\S]*?)\n\n/.exec(doc)
    const windows = /Windows: ([\s\S]*?)\n\n/.exec(doc)
    expect(posix).not.toBeNull()
    expect(windows).not.toBeNull()
    const names = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
    expect([...names(posix![1]!), ...names(windows![1]!)]).toEqual(constant)
    expect(names(windows![1]!)[0]).toBe('SYSTEMROOT')
  })

  it("history.md's default window is DEFAULT_RECENT", () => {
    const recent = /const DEFAULT_RECENT = (\d+)/.exec(read('src/orchestrator/history.ts'))
    expect(recent).not.toBeNull()
    expect(read('docs/modules/history.md')).toContain(
      `// the window; defaults to ${recent![1]} invocations`,
    )
  })

  it("run-context.md's CI matrix is CI_PROVIDERS, in order", () => {
    const arr = /const CI_PROVIDERS[^=]*= \[([\s\S]*?)\n\]/.exec(
      read('src/orchestrator/run-context.ts'),
    )
    expect(arr).not.toBeNull()
    const providers = [...arr![1]!.matchAll(/\['\w+', '(\w+)'\]/g)].map((m) => m[1]!)
    const doc = read('docs/modules/run-context.md')
    const bullet = /first truthy variable wins[\s\S]*?: ([\s\S]*?)\.\n/.exec(doc)
    expect(bullet).not.toBeNull()
    const named = [...bullet![1]!.matchAll(/`(\w+)`/g)].map((m) => m[1]!).filter((n) => n !== 'CI')
    expect(named).toEqual(providers)
  })

  it("config-cache.md's impurity list is IMPURE_RE's", () => {
    const re = /const IMPURE_RE =\n\s+\/\\b\(\?:([^)]+)\)\\b\|import/.exec(
      read('src/workspace/config-cache.ts'),
    )
    expect(re).not.toBeNull()
    const words = re![1]!.split('|').map((w) => w.replace(/\\w\*$/, '*'))
    const doc = read('docs/modules/config-cache.md')
    const bullet = /no file\n\s+mentions a global[\s\S]*?leak: ([\s\S]*?)`import\(`;/.exec(doc)
    expect(bullet).not.toBeNull()
    // The aside repeats `globalThis` and `process` and quotes an expression;
    // the list itself names each word once.
    const aside = new Set(["global['proc' + 'ess']", 'import.meta', 'Math.random'])
    const seen = new Set<string>()
    const named = [...bullet![1]!.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1]!)
      .filter((n) => !aside.has(n) && !seen.has(n) && (seen.add(n), true))
    expect(named).toEqual(words)
  })

  it("cli-cache.md's two regexes are parseDuration's and parseSize's", () => {
    const doc = read('docs/modules/cli-cache.md')
    const quoted = [...doc.matchAll(/```\n(\/[^\n]+\/i?)\n```/g)].map((m) => m[1]!)
    expect(quoted).toHaveLength(2)
    const duration = /export function parseDuration[\s\S]*?input\.match\((\/.*\/i?)\)$/m.exec(
      read('src/cli/cache.ts'),
    )
    const size = /export function parseSize[\s\S]*?input\.match\((\/.*\/i?)\)$/m.exec(
      read('src/util/size.ts'),
    )
    expect(quoted).toEqual([duration![1]!, size![1]!])
  })
})

describe('a module page lists the functions the module exports', () => {
  it("metrics.md's signature block names every exported function, and counts them", () => {
    const src = read('src/orchestrator/metrics.ts')
    const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!)
    const doc = read('docs/modules/metrics.md')
    const block = /```ts\n([\s\S]*?)```/.exec(doc)
    expect(block).not.toBeNull()
    const named = [...block![1]!.matchAll(/^(\w+)\(db/gm)].map((m) => m[1]!)
    expect([...named].sort()).toEqual([...exported].sort())
    const WORDS = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ]
    expect(doc).toContain(`the same ${WORDS[exported.length]} signatures`)
  })
})

describe('cli-help.md names every section the help text has', () => {
  it('its Sections list holds each header, in order', () => {
    const src = read('src/cli/help.ts')
    const headers = [...src.matchAll(/^    '([A-Z][^']*):',$/gm)].map((m) => m[1]!)
    expect(headers.length).toBeGreaterThan(8)
    const doc = read('docs/modules/cli-help.md')
    const section = /## Sections \(current\)\n([\s\S]*?)\n## /.exec(doc)
    expect(section).not.toBeNull()
    const named = [...section![1]!.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!)
    expect(named).toEqual(headers)
  })
})
