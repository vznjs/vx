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
import { formatBytes } from '../src/cli/format.js'
import { ulid } from '../src/util/ulid.js'

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
      // A `readonly` field is a field; a method (`arm(): …`) is not one.
      const m = /^\s*(?:readonly\s+)?(\w+)\??:/.exec(line)
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
  ['admission', 'orchestrator/admission.ts', 'AdmissionArgs'],
  ['sandbox-request', 'orchestrator/sandbox-request.ts', 'SandboxArmer'],
  ['sandbox-request', 'orchestrator/sandbox-request.ts', 'SandboxRequest'],
  ['sandbox-request', 'orchestrator/sandbox-request.ts', 'Placeholder'],
  ['sandbox-request', 'orchestrator/sandbox-request.ts', 'SandboxRunUnion'],
  ['git-inputs', 'cache/git-inputs.ts', 'GitEnumeration'],
  ['upgrade', 'cli/upgrade.ts', 'ReleaseAsset'],
  ['cli-watch', 'cli/watch.ts', 'ArmedWatcher'],
  ['logger', 'orchestrator/logger.ts', 'OutputView'],
  ['colors', 'orchestrator/colors.ts', 'ColorSupport'],
  ['colors', 'orchestrator/colors.ts', 'PaintOptions'],
  ['local-shortcircuit', 'orchestrator/local-shortcircuit.ts', 'ShortCircuitArgs'],
  ['local-shortcircuit', 'orchestrator/local-shortcircuit.ts', 'ProbedEntry'],
  ['local-shortcircuit', 'orchestrator/local-shortcircuit.ts', 'ShortCircuit'],
  ['plan', 'orchestrator/plan.ts', 'PlannedTask'],
  ['plan', 'orchestrator/plan.ts', 'PlanPrediction'],
  ['plan', 'orchestrator/plan.ts', 'RunPlan'],
  ['plan', 'orchestrator/plan.ts', 'PlanArgs'],
  ['tally', 'orchestrator/tally.ts', 'Tally'],
  ['tally', 'orchestrator/tally.ts', 'TallyItem'],
  ['fingerprint', 'workspace/fingerprint.ts', 'WorkspaceFingerprints'],
  ['lockfile-claim', 'orchestrator/lockfile-claim.ts', 'LockfileClaimOptions'],
  ['lockfile-claim', 'orchestrator/lockfile-claim.ts', 'LockfileClaimHooks'],
  ['lockfile-claim', 'orchestrator/lockfile-claim.ts', 'ReachGraph'],
  ['task-log-buffer', 'orchestrator/task-log-buffer.ts', 'TaskLogEntry'],
  ['task-log-buffer', 'orchestrator/task-log-buffer.ts', 'TaskLogBundle'],
  ['util-tail', 'util/tail.ts', 'Tail'],
  ['package-graph', 'workspace/package-graph.ts', 'PackageGraph'],
  ['projects', 'orchestrator/projects.ts', 'LoadProjectsArgs'],
  ['projects', 'orchestrator/projects.ts', 'LoadedProjects'],
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

  it("util-ulid.md's id is the width and shape ulid() produces", () => {
    // The page described a 26-char Crockford-base32 ULID two rewrites after
    // the generator became Bun.randomUUIDv7 (item 327, 2026-09-16).
    const id = ulid()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const doc = read('docs/modules/util-ulid.md')
    expect(doc).toContain(`a ${id.length}-character UUIDv7`)
    expect(doc).not.toContain('26-character')
  })

  it("fingerprint.md's file table is WORKSPACE_FINGERPRINT_FILES, in order", () => {
    const arr = /export const WORKSPACE_FINGERPRINT_FILES = \[([\s\S]*?)\n\]/.exec(
      read('src/workspace/fingerprint.ts'),
    )
    expect(arr).not.toBeNull()
    const files = [...arr![1]!.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    const doc = read('docs/modules/fingerprint.md')
    const rows = [...doc.matchAll(/^\| `([^`]+)`\s+\| [^|]+\|$/gm)].map((m) => m[1]!)
    expect(rows).toEqual(files)
  })

  it('the util pages quote the constants their modules declare', () => {
    // [page, source, the declaration line the page must carry verbatim]
    const quoted: ReadonlyArray<[page: string, source: string, decl: RegExp]> = [
      ['util-num', 'util/num.ts', /^export const MAX_TIMEOUT_MS = .*$/m],
      ['util-tail', 'util/tail.ts', /^export const PERSISTENT_TAIL_CHARS = .*$/m],
      [
        'task-log-buffer',
        'orchestrator/task-log-buffer.ts',
        /^export const TASK_LOG_TAIL_CHARS = .*$/m,
      ],
      [
        'task-log-buffer',
        'orchestrator/task-log-buffer.ts',
        /^export const RUN_LOG_BUDGET_CHARS = .*$/m,
      ],
      [
        'task-log-buffer',
        'orchestrator/task-log-buffer.ts',
        /^export const LOG_WIRE_VERSION = .*$/m,
      ],
    ]
    for (const [page, source, decl] of quoted) {
      const line = decl.exec(read(`src/${source}`))
      expect(line).not.toBeNull()
      expect(read(`docs/modules/${page}.md`)).toContain(line![0])
    }
    const settle = /const DEFAULT_TIMEOUT_MS = (\d+)/.exec(read('src/util/settle.ts'))
    expect(read('docs/modules/util-settle.md')).toContain(`// default ${settle![1]}`)
  })

  it("download-policy.md's DownloadMode is the source's union", () => {
    const line = /^export type DownloadMode = .*$/m.exec(
      read('src/orchestrator/download-policy.ts'),
    )
    expect(line).not.toBeNull()
    expect(read('docs/modules/download-policy.md')).toContain(`${line![0]}\n`)
  })

  it("cli-cache.md's two regexes are parseDuration's and parseSize's", () => {
    const doc = read('docs/modules/cli-cache.md')
    const quoted = [...doc.matchAll(/```\n(\/[^\n]+\/i?)\n```/g)].map((m) => m[1]!)
    expect(quoted).toHaveLength(2)
    const duration = /export function parseDuration[\s\S]*?input\.match\((\/.*\/i?)\)$/m.exec(
      read('src/util/size.ts'),
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
    // What "a reader over another store" reimplements: the functions over
    // the Database. `diffKeyComponents` (item 703) is the join alone.
    const overStore = [...src.matchAll(/^export (?:async )?function (\w+)\(\s*db: Database/gm)].map(
      (m) => m[1]!,
    )
    expect(exported.filter((f) => !overStore.includes(f))).toEqual(['diffKeyComponents'])
    const doc = read('docs/modules/metrics.md')
    const block = /```ts\n([\s\S]*?)```/.exec(doc)
    expect(block).not.toBeNull()
    const named = [...block![1]!.matchAll(/^(\w+)\(/gm)].map((m) => m[1]!)
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
    expect(doc).toContain(`the same ${WORDS[overStore.length]} signatures`)
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

describe('a module page shows what a formatter prints', () => {
  it("cli-format.md's byte table is formatBytes, row for row", () => {
    const doc = read('docs/modules/cli-format.md')
    const rows = [...doc.matchAll(/^\| `([^`]+)`\s+\| `([^`]+)`\s+\|$/gm)].map((m) => [
      m[1]!,
      m[2]!,
    ])
    const inputs: ReadonlyArray<[expr: string, n: number]> = [
      ['0', 0],
      ['1023', 1023],
      ['1024', 1024],
      ['9 * 1024 + 100', 9 * 1024 + 100],
      ['10 * 1024', 10 * 1024],
      ['1024 ** 2', 1024 ** 2],
      ['5 * 1024 ** 3', 5 * 1024 ** 3],
    ]
    expect(rows).toEqual(inputs.map(([expr, n]) => [expr, formatBytes(n)]))
  })
})

describe('a module page lists the errors a parser throws', () => {
  it("dependency-spec.md's five errors are parseDependencySpec's, as a set", () => {
    const src = read('src/graph/dependency-spec.ts')
    const thrown = new Set(
      [...src.matchAll(/new DependencySpecError\(raw, '([^']+)'\)/g)].map((m) => m[1]!),
    )
    const doc = read('docs/modules/dependency-spec.md')
    const errors = /Errors:\n\n([\s\S]*?)\n\n/.exec(doc)
    expect(errors).not.toBeNull()
    const named = new Set([...errors![1]!.matchAll(/→ `([^`]+)`/g)].map((m) => m[1]!))
    expect(named).toEqual(thrown)
    expect(thrown.size).toBe(5)
  })
})

describe('a module page names every export the module has', () => {
  const EXPORT_RE = /^export (?:async )?(?:interface|type|const|function) (\w+)/gm
  for (const [page, source, atLeast] of [
    ['docs/modules/config.md', 'src/config.ts', 12],
    ['docs/modules/projects.md', 'src/orchestrator/projects.ts', 4],
  ] as const) {
    it(`${page}'s surface block names each export of ${source}`, () => {
      const exported = [...read(source).matchAll(EXPORT_RE)].map((m) => m[1]!)
      expect(exported.length).toBeGreaterThan(atLeast)
      const block = /## Public surface\n\n```ts\n([\s\S]*?)```/.exec(read(page))
      expect(block).not.toBeNull()
      const named = new Set([...block![1]!.matchAll(EXPORT_RE)].map((m) => m[1]!))
      expect(exported.filter((n) => !named.has(n))).toEqual([])
    })
  }
})

describe('index.md names every export of the façade, values and types apart', () => {
  const values = new Set<string>()
  const types = new Set<string>()
  for (const m of read('src/index.ts').matchAll(/^export (type )?\{([^}]*)\} from/gm)) {
    for (const raw of m[2]!.split(',')) {
      const entry = raw.trim()
      if (entry === '') continue
      if (m[1] !== undefined || entry.startsWith('type ')) types.add(entry.replace(/^type /, ''))
      else values.add(entry.split(' as ').at(-1)!)
    }
  }
  const doc = read('docs/modules/index.md')
  const rows = [...doc.matchAll(/^\| [^|]+ \| ([^|]*) \| ([^|]*) \|$/gm)]
  const column = (i: 1 | 2): string[] =>
    rows.flatMap((r) => [...r[i]!.matchAll(/`(\w+)`/g)].map((m) => m[1]!)).sort()
  it('the values column is the runtime symbol set, and the count in prose is its size', () => {
    expect(values.size).toBeGreaterThan(30)
    expect(column(1)).toEqual([...values].sort())
    expect(doc).toContain(`set (${values.size} names)`)
  })
  it('the types column is every export type', () => {
    expect(types.size).toBeGreaterThan(60)
    expect(column(2)).toEqual([...types].sort())
  })
})

describe('plugin-host.md names every export of the host', () => {
  it('its Public surface section holds each export', () => {
    const src = read('src/orchestrator/plugin-host.ts')
    const exported = [...src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(
      (m) => m[1]!,
    )
    expect(exported.length).toBeGreaterThan(10)
    const section = /## Public surface\n([\s\S]*?)\n## /.exec(read('docs/modules/plugin-host.md'))
    expect(section).not.toBeNull()
    const named = new Set([...section![1]!.matchAll(/`(\w+)/g)].map((m) => m[1]!))
    expect(exported.filter((n) => !named.has(n))).toEqual([])
  })
})

describe('a module page lists the tests its suite has', () => {
  it("package-graph.md's Tests bullets are the suite's it names, in order", () => {
    const src = read('tests/package-graph.test.ts')
    const names = [...src.matchAll(/^  it\('(.+)', \(\) => \{$/gm)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(10)
    const doc = read('docs/modules/package-graph.md')
    const section = /## Tests\n\n`tests\/package-graph\.test\.ts`:\n\n([\s\S]*?)\n\n/.exec(doc)
    expect(section).not.toBeNull()
    expect([...section![1]!.matchAll(/^- (.+)$/gm)].map((m) => m[1]!)).toEqual(names)
  })
})

describe('timing.md lists every mark and span the run path records', () => {
  const section = (): string => {
    const m = /## Marks and spans \(current\)\n([\s\S]*?)\n## /.exec(read('docs/modules/timing.md'))
    expect(m).not.toBeNull()
    return m![1]!
  }
  const items = (text: string): string[] => [...text.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]!)
  it('the marks, in the order prepare.ts then run.ts end them', () => {
    const src = read('src/orchestrator/prepare.ts') + read('src/orchestrator/run.ts')
    const marks = [...new Set([...src.matchAll(/\bmark\('([^']+)'\)/g)].map((m) => m[1]!))]
    expect(marks.length).toBeGreaterThan(10)
    expect(items(section().split('\nSpans,')[0]!)).toEqual(marks)
  })
  // benchmarks.md § Profiling a run names the same table in prose, and named
  // nine of the fourteen — as an appositive that reads as the sequence, with
  // `startup`, `workspace config`, `plugin stages`, `save lane` (a mark
  // gone since item 634) and
  // `output dir snapshots` missing (item 360, 2026-09-19). One list was
  // pinned, its sibling was not: the class this loop keeps meeting.
  it('benchmarks.md names the same marks, in the same order', () => {
    const src = read('src/orchestrator/prepare.ts') + read('src/orchestrator/run.ts')
    const marks = [...new Set([...src.matchAll(/\bmark\('([^']+)'\)/g)].map((m) => m[1]!))]
    const doc = read('docs/benchmarks.md')
    const start = doc.indexOf('**`VX_TIMING=1 vx run …`**')
    expect(start).toBeGreaterThan(-1)
    const sentence = doc.slice(start, doc.indexOf('This is the first thing to', start))
    expect(
      [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((n) => marks.includes(n)),
    ).toEqual(marks)
  })

  it('the spans, one per label anywhere under src/', () => {
    const labels = new Set<string>()
    for (const rel of new Bun.Glob('src/**/*.ts').scanSync({ cwd: pkg })) {
      if (rel.endsWith('util/timing.ts')) continue
      for (const m of read(rel).matchAll(/\bspan\('([^']+)'\)/g)) labels.add(m[1]!)
    }
    expect(labels.size).toBeGreaterThan(15)
    expect([...items(section().split('\nSpans,')[1]!)].sort()).toEqual([...labels].sort())
  })
})
