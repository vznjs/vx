// The site's guides show terminal output "as it prints"; a sample nobody
// renders drifts (the formatter's own docblock showed a glyph it never
// wrote, item 302, 2026-09-16). Each sample here is rendered with the
// real formatter and compared byte for byte. The site
// lives outside packages/vx, which a sandboxed shard cannot read — hence
// the unsafe suite (the site's own tests reach only the public API).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { formatPlanText } from '../src/cli/plan-format.js'
import { formatTaskHitLine } from '../src/orchestrator/framed-output.js'
import { formatFlakySection } from '../src/orchestrator/summary.js'
import { localExecutor } from '../src/exec/local-executor.js'
import { CACHE_LAYER_METHODS } from '../src/orchestrator/plugin-host.js'
import { PLUGIN_HOOKS } from '../src/config.js'
import { ESSENTIAL_ENV } from '../src/exec/env.js'
import type { RunPlan } from '../src/orchestrator/plan.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'

const GUIDES = path.resolve(
  import.meta.dir,
  '..',
  '..',
  'vx-docs',
  'src',
  'content',
  'docs',
  'guides',
)

const DOCS = path.dirname(GUIDES)
const HELP = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cli', 'help.ts'), 'utf8')

function fencedBlock(page: string, lang: string, firstLine: string): string {
  const open = `\`\`\`${lang}\n${firstLine}`
  const start = page.indexOf(open)
  expect(start).toBeGreaterThan(-1)
  const body = start + lang.length + 4
  const end = page.indexOf('```', body)
  return page.slice(body, end)
}

describe('the running-tasks guide shows what --dry prints', () => {
  it('its `would run:` block is formatPlanText on three local hits', () => {
    const page = readFileSync(path.join(GUIDES, 'running-tasks.md'), 'utf8')
    const task = (id: string, hash: string) => ({
      node: {
        id,
        projectName: id.split('#')[0]!,
        taskName: id.split('#')[1]!,
        config: {},
      } as unknown as TaskNode,
      hash,
      cacheStatus: 'hit-local' as const,
      deps: [],
    })
    const plan: RunPlan = {
      tasks: [
        task('@acme/api#build', '8625b6031a2b3c4d'),
        task('@acme/ui#build', '71e5d9a05e6f7a8b'),
        task('@acme/web#build', '42e9b39d9c0d1e2f'),
      ],
    }
    expect(fencedBlock(page, 'text', 'would run:')).toBe(formatPlanText(plan))
  })
})

describe('the plugins guide states the CacheLayer method count', () => {
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
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ]
  it('"the N `CacheLayer` methods" is CACHE_LAYER_METHODS.length', () => {
    const page = readFileSync(path.join(GUIDES, 'plugins.md'), 'utf8')
    const m = /the ([a-z]+) `CacheLayer` methods/.exec(page)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(WORDS[CACHE_LAYER_METHODS.length])
  })
})

describe('the environment-variables guide names the essential allowlist', () => {
  it('its "always gets a small essential allowlist" sentence names every POSIX name in ESSENTIAL_ENV', () => {
    const page = readFileSync(path.join(GUIDES, 'environment-variables.md'), 'utf8')
    const m = /essential allowlist so normal CLI tools\s+work:([\s\S]*?)plus the Windows/.exec(page)
    expect(m).not.toBeNull()
    const named = new Set([...m![1]!.matchAll(/`([A-Z_]+)`/g)].map((x) => x[1]!))
    const posix = ESSENTIAL_ENV.slice(0, ESSENTIAL_ENV.indexOf('SYSTEMROOT'))
    expect(posix.length).toBeGreaterThan(10)
    for (const name of posix) expect(named).toContain(name)
  })
})

describe('the remote-execution guide states the wire chunk sizes', () => {
  it('its uploads bullet names CHUNK_BYTES in KB and the SAFE_CHUNK_BYTES retry size', () => {
    const wire = readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'vx-reapi', 'src', 'wire.ts'),
      'utf8',
    )
    const chunk = /export const CHUNK_BYTES = (\d+) \* 1024/.exec(wire)
    const safe = /export const SAFE_CHUNK_BYTES = (\d+)/.exec(wire)
    expect(chunk).not.toBeNull()
    expect(safe).not.toBeNull()
    const page = readFileSync(path.join(GUIDES, 'remote-execution.md'), 'utf8')
    const m =
      /- Uploads chunk at (\d+) KB[\s\S]*?retries once\s+at (\d+) bytes — `SAFE_CHUNK_BYTES`/.exec(
        page,
      )
    expect(m).not.toBeNull()
    expect(m![1]).toBe(chunk![1])
    expect(m![2]).toBe(safe![1])
  })
})

describe('the quickstart shows what a run prints and what its flags do', () => {
  it('the `vx run build` hit comment opens with the glyph and words formatTaskHitLine prints for a local hit', () => {
    // The page showed ◌, a glyph no source file prints (item 312, 2026-09-16).
    const page = readFileSync(path.join(DOCS, 'quickstart.md'), 'utf8')
    const m = /^vx run build\s+# (\S+) (\S+ \S+) —/m.exec(page)
    expect(m).not.toBeNull()
    const node = {
      id: 'app#build',
      projectName: 'app',
      taskName: 'build',
      config: { exec: { command: 'tsc -b' }, cache: {} },
    } as unknown as TaskNode
    const outcome = {
      node,
      status: 'cache-hit',
      exitCode: 0,
      durationMs: 12,
      hash: 'abcdef0123456789',
      restored: true,
    } as unknown as TaskOutcome
    const row = formatTaskHitLine(node, outcome)
    expect(m![1]).toBe(row.trimStart().split(' ')[0]!)
    expect(row.replace(/\s+/g, ' ')).toContain(` ${m![2]} `)
  })

  it('the --graph comment says what `vx help` says: DOT', () => {
    const page = readFileSync(path.join(DOCS, 'quickstart.md'), 'utf8')
    expect(HELP).toContain('--graph[=<path>]     Emit Graphviz DOT')
    const m = /^vx run build --graph\s+# (.*)$/m.exec(page)
    expect(m![1]).toBe('the task graph as Graphviz DOT')
  })
})

describe('the add-to-existing-repo page states the concurrency default `vx help` states', () => {
  it("its `concurrency` comment is the help line's default clause", () => {
    const help = /--concurrency <n>\s+Max parallel tasks \(default: ([^)]+)\)/.exec(HELP)
    expect(help).not.toBeNull()
    const page = readFileSync(path.join(DOCS, 'add-to-existing-repo.md'), 'utf8')
    const m = /^\s+concurrency: 8,\s+\/\/ default: (.*)$/m.exec(page)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(help![1])
  })
})

describe('the trusting-the-cache guide quotes what vx why says', () => {
  const guide = readFileSync(path.join(GUIDES, 'trusting-the-cache.md'), 'utf8')
  const post = readFileSync(path.join(DOCS, 'blog', 'why-did-this-rerun.md'), 'utf8')
  it("every verdict sentence metrics.ts can print is a row of its table, and of the post's", () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'metrics.ts'),
      'utf8',
    )
    // The verdict notes: `unchangedKeyNote` and the ternary beside it. The
    // detail notes further down (`(same inputs)` onward) are `vx why`'s
    // second line, not its verdict.
    const verdicts = src.slice(
      src.indexOf('function unchangedKeyNote'),
      src.indexOf('(same inputs)'),
    )
    const notes = [
      ...verdicts.matchAll(/'((?:cache key|this task declares no `cache` block)[^']*)'/g),
    ].map((m) => m[1]!)
    expect(notes.length).toBe(5)
    for (const note of notes) {
      expect(guide).toContain(note)
      expect(post).toContain(note)
    }
  })
  it('its console sample carries the labels why.ts prints, and a row in its shape', () => {
    const why = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cli', 'why.ts'), 'utf8')
    const sample = fencedBlock(guide, 'console', 'app#build — run ')
    for (const label of ['  this run   ', '  previous   ', '  verdict    ', '  what changed (']) {
      expect(why).toContain(label)
      expect(sample).toContain(label)
    }
    // `${change.padEnd(7)} ${kind.padEnd(4)}  ${name}  ${before} → ${after}`
    expect(sample).toMatch(/^    changed file  \S+  \S+ → \S+$/m)
  })
})

describe('the why-vx-is-fast concept quotes the benchmarks page', () => {
  it('each figure it states is on docs/benchmarks.md as written', () => {
    const page = readFileSync(path.join(DOCS, 'concepts', 'why-vx-is-fast.md'), 'utf8')
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    for (const figure of [
      '3m 38s',
      '3m 46s',
      '5m 13s',
      '34m 44s',
      '1,712 ms per',
      '1,090 packages',
      '100 dependency layers',
      '74 ms',
      '172 ms',
      '16–25 ms',
    ]) {
      expect(page).toContain(figure)
      expect(bench).toContain(figure)
    }
  })
})

describe('the flaky-tasks post shows the section the footer prints', () => {
  it('its sample is formatFlakySection on the two findings it describes', () => {
    const page = readFileSync(path.join(DOCS, 'blog', 'flaky-tasks.md'), 'utf8')
    const sample = fencedBlock(page, '', '  Flaky:').replace(/\n$/, '')
    const finding = (
      taskId: string,
      status: 'success' | 'failed',
      passes: number,
      failures: number,
      attempts = 1,
    ) => {
      const [project, task] = taskId.split('#') as [string, string]
      return { taskId, project, task, hash: 'k', status, passes, failures, attempts }
    }
    expect(sample.split('\n')).toEqual(
      formatFlakySection([
        finding('app#test', 'failed', 3, 1),
        finding('api#e2e', 'success', 1, 1, 2),
      ]).slice(1),
    )
  })
})

describe('the local-floor post names the placement labels --dry prints', () => {
  it("`@local` is the local executor's name and `@noop` the no-op placement", () => {
    const page = readFileSync(path.join(DOCS, 'blog', 'the-local-floor.md'), 'utf8')
    expect(page).toContain('`@' + localExecutor().name + '`')
    const placement = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'placement.ts'),
      'utf8',
    )
    expect(placement).toContain("'noop'")
    expect(page).toContain('`@noop`')
  })
})

describe('the no-daemon post quotes the benchmarks page', () => {
  it('each warm-run figure it states is on docs/benchmarks.md as written', () => {
    const page = readFileSync(path.join(DOCS, 'blog', 'no-daemon.md'), 'utf8')
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    for (const figure of ['510ms', '760ms', '3.59s', '51 ms', '95 ms']) {
      expect(page).toContain(figure)
      expect(bench).toContain(figure)
    }
  })
})

describe('the strict-output-ownership post names what the wipe never touches', () => {
  it('every OUTPUT_NEVER directory is in its list, and nothing claims more', () => {
    const page = readFileSync(path.join(DOCS, 'blog', 'strict-output-ownership.md'), 'utf8')
    const section = /## What the wipe never touches\n([\s\S]*?)\n## /.exec(page)
    expect(section).not.toBeNull()
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'cache', 'inputs.ts'),
      'utf8',
    )
    const arr = /const OUTPUT_NEVER = \[([^\]]*)\]/.exec(src)
    expect(arr).not.toBeNull()
    const names = [...arr![1]!.matchAll(/'\*\*\/([^/']+)\/\*\*'/g)].map((m) => m[1]!)
    expect(names.length).toBe(2)
    for (const name of names) expect(section![1]!).toContain('`' + name + '`')
    expect(section![1]!).toContain('`node_modules/**` is a legitimate output')
  })
})

describe('the why pages name every component kind the key records', () => {
  const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cache', 'cache.ts'), 'utf8')
  const kinds = [...new Set([...src.matchAll(/kind: '([\w-]+)'/g)].map((m) => m[1]!))]
  it('cache.ts records ten kinds', () => {
    expect(kinds.length).toBe(10)
  })
  for (const [label, file] of [
    ['the why-did-this-rerun post', path.join(DOCS, 'blog', 'why-did-this-rerun.md')],
    ['docs/cli.md', path.resolve(import.meta.dir, '..', 'docs', 'cli.md')],
  ] as const) {
    it(`${label} names each kind`, () => {
      const text = readFileSync(file, 'utf8')
      for (const kind of kinds) expect(text).toContain('`' + kind + '`')
    })
  }
})

describe('the watch-mode post states what watch.ts does', () => {
  const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cli', 'watch.ts'), 'utf8')
  const page = readFileSync(path.join(DOCS, 'blog', 'watch-mode.md'), 'utf8')
  it('its debounce and probe timeout are the constants', () => {
    expect(src).toContain('const DEBOUNCE_MS = 150')
    expect(page).toContain('about 150 ms')
    expect(src).toContain('const WATCH_PROBE_TIMEOUT_MS = 2_000')
    expect(page).toContain('silent for\ntwo seconds')
  })
  it('its always-ignored list names every ignored segment and suffix', () => {
    const list = (name: string): string[] => {
      const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(src)
      expect(m).not.toBeNull()
      return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
    }
    for (const seg of list('IGNORED_SEGMENTS')) expect(page).toContain('`' + seg + '`')
    for (const suffix of list('IGNORED_SUFFIXES')) expect(page).toContain('`' + suffix + '`')
  })
  it('its rejected-flags sentence names every flag the loop refuses', () => {
    const refused = new Set<string>()
    for (const m of src.matchAll(/vx watch: ([^\n]*?) are not supported in watch mode/g)) {
      for (const f of m[1]!.matchAll(/--[\w-]+/g)) refused.add(f[0])
    }
    expect(refused.size).toBeGreaterThan(5)
    const sentence = /Flags that describe one run \(([^)]*)\)/.exec(page)
    expect(sentence).not.toBeNull()
    const named = new Set([...sentence![1]!.matchAll(/--[\w-]+/g)].map((m) => m[0]))
    expect([...named].sort()).toEqual([...refused].sort())
  })
})

describe('the agents-and-mcp post tabulates every tool the server offers', () => {
  it('each `name:` in tools.ts is a row of its table', () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'vx-mcp', 'src', 'tools.ts'),
      'utf8',
    )
    const names = [...src.matchAll(/^    name: '(\w+)',$/gm)].map((m) => m[1]!)
    expect(names.length).toBe(6)
    const page = readFileSync(path.join(DOCS, 'blog', 'agents-and-mcp.md'), 'utf8')
    const rows = [...page.matchAll(/^\| `(\w+)` +\|/gm)].map((m) => m[1]!)
    expect(rows.sort()).toEqual([...names].sort())
  })
})

describe('the why-vx-is-fast post quotes the benchmarks page', () => {
  it('each figure it states is on docs/benchmarks.md as written', () => {
    const page = readFileSync(path.join(DOCS, 'blog', 'why-vx-is-fast.md'), 'utf8')
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    for (const figure of [
      '3m 38s',
      '3m 46s',
      '5m 13s',
      '34m 44s',
      '510ms',
      '760ms',
      '3.59s',
      '66 ms',
      '127 ms',
    ]) {
      expect(page).toContain(figure)
      expect(bench).toContain(figure)
    }
  })
})

describe('the telemetry post shows the sink contract the source declares', () => {
  const src = readFileSync(
    path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'telemetry.ts'),
    'utf8',
  )
  const page = readFileSync(path.join(DOCS, 'blog', 'telemetry-never-breaks-a-run.md'), 'utf8')
  const block = fencedBlock(page, 'ts', 'interface TelemetrySink {')
  it('its interface block names every field of TelemetrySink, and no other', () => {
    const decl = /export interface TelemetrySink \{([\s\S]*?)\n\}/.exec(src)
    expect(decl).not.toBeNull()
    const fields = (text: string): string[] =>
      [...text.matchAll(/^  (?:readonly )?(\w+)\??[(:]/gm)].map((m) => m[1]!).sort()
    expect(fields(block)).toEqual(fields(decl![1]!))
    expect(fields(block).length).toBe(5)
  })
  it('its `wants` union is every record kind', () => {
    const kinds = [...new Set([...src.matchAll(/kind: '([a-z.]+)'/g)].map((m) => m[1]!))].sort()
    const union = /wants\?: ReadonlyArray<([^>]*)>/.exec(block)
    expect(union).not.toBeNull()
    const named = [...union![1]!.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]!).sort()
    expect(named).toEqual(kinds)
  })
})

describe('the bitsets post states what the scheduler source measured', () => {
  const src = readFileSync(
    path.resolve(import.meta.dir, '..', 'src', 'graph', 'scheduler.ts'),
    'utf8',
  )
  const page = readFileSync(path.join(DOCS, 'blog', 'bitsets-and-the-scheduler.md'), 'utf8')
  const flat = page.replace(/\s+/g, ' ')
  it('its closure figures are the ones computeReverseDepCount records', () => {
    // The post carried "roughly 50 ms" where the source (and
    // optimizations.md 9b) say single-digit (item 341, 2026-09-16) —
    // the same fault items 334, 336 and 340 fixed on four other pages.
    const note = src.slice(
      src.indexOf('export function computeReverseDepCount'),
      src.indexOf('const ids = '),
    )
    for (const [inSource, inPage] of [
      ['8.5s', '8.5 seconds'],
      ['single-digit ms', 'single-digit milliseconds'],
      ['1.3 MB', '1.3 MB'],
    ] as const) {
      expect(note).toContain(inSource)
      expect(flat).toContain(inPage)
    }
    expect(flat).not.toContain('50 ms')
  })
  it('the ready structure it names is the one the scheduler builds', () => {
    expect(src).toContain('A binary max-heap of ready task ids')
    expect(flat).toContain('binary max-heap')
  })
  it('its restore lane is capped where the scheduler caps it', () => {
    expect(src).toContain('const restoreConcurrency = concurrency === 1 ? 1 : 2 * concurrency')
    expect(flat).toContain('twice the worker count')
    expect(flat).toContain('`--concurrency 1` stays serial')
  })
})

describe('the keys-from-git post counts the parts the key folds', () => {
  const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cache', 'cache.ts'), 'utf8')
  const key = src.slice(
    src.indexOf('async key(input: CacheKeyInput)'),
    src.indexOf('async get(hash: string'),
  )
  const labels = [...new Set([...key.matchAll(/h = xxh3\(`([a-z-]+):/g)].map((m) => m[1]!))]
  const page = readFileSync(path.join(DOCS, 'blog', 'keys-from-git.md'), 'utf8')
  it('"twelve parts" is CACHE_VERSION plus every labelled fold, and the list has twelve items', () => {
    expect(labels.length + 1).toBe(12)
    expect(page).toContain('seed-chained across twelve parts')
    const list = /\n1\. The key-derivation sentinel([\s\S]*?)\n\nPart 11/.exec(page)
    expect(list).not.toBeNull()
    const items = [...list![1]!.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
    expect([1, ...items]).toEqual([...Array(12)].map((_, i) => i + 1))
  })
  it('every label it quotes is one the key folds under', () => {
    const quoted = [...page.matchAll(/`([a-z-]+):`/g)].map((m) => m[1]!)
    expect(quoted.length).toBeGreaterThan(3)
    for (const label of quoted) expect(labels).toContain(label)
  })
  it('it says the plugin part folds where the source folds it — before the input files', () => {
    expect(labels.indexOf('plugin')).toBeLessThan(labels.indexOf('inputs'))
    expect(page.replace(/\s+/g, ' ')).toContain('folded right after the upstream keys')
  })
  it('each git command it names is spelled as git-inputs.ts spawns it', () => {
    const git = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'cache', 'git-inputs.ts'),
      'utf8',
    )
    const spawned = [...git.matchAll(/spawnGit\(\[([^\]]*)\]/g)].map((m) =>
      [
        'git',
        ...[...m[1]!.matchAll(/'([^']*)'/g)]
          .map((t) => t[1]!)
          .filter((t) => t !== '-z' && t !== '--'),
      ].join(' '),
    )
    expect(spawned.length).toBeGreaterThan(3)
    for (const named of [
      'git ls-files -s -v',
      'git status --porcelain -uall',
      'git config --get-regexp',
    ]) {
      expect(spawned.some((s) => s.startsWith(named))).toBe(true)
      expect(page).toContain('`' + named)
    }
  })
})

describe('the resolved-config-hashing post names every global the gate denies', () => {
  const src = readFileSync(
    path.resolve(import.meta.dir, '..', 'src', 'workspace', 'config-cache.ts'),
    'utf8',
  )
  const page = readFileSync(path.join(DOCS, 'blog', 'resolved-config-hashing.md'), 'utf8')
  it('each identifier in IMPURE_RE is a name in its list', () => {
    const re = /const IMPURE_RE =\n\s+\/\\b\(\?:([^)]*)\)\\b/.exec(src)
    expect(re).not.toBeNull()
    const names = re![1]!.split('|')
    expect(names.length).toBeGreaterThan(15)
    for (const name of names) {
      // `toLocale\w*` is a family, written `toLocale*` in prose.
      expect(page).toContain('`' + name.replace('\\w*', '*') + '`')
    }
    for (const form of ['`import.meta`', '`Math.random`', '`import()`'])
      expect(page).toContain(form)
  })
  it('its closure-size bound is MAX_CLOSURE_FILES', () => {
    const m = /const MAX_CLOSURE_FILES = (\d+)/.exec(src)
    expect(m).not.toBeNull()
    expect(page.replace(/\s+/g, ' ')).toContain(`more than ${m![1]} files evaluates live`)
  })
  it('its config-eval figures are the ones benchmarks.md measured, as the concept page states them', () => {
    // The post said the gate is "worth about 20 ms", the fault item 334
    // fixed on the concept page: 16-25 ms is what the cached stage COSTS,
    // against the ~200 ms of evaluations it replaces.
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    const concept = readFileSync(path.join(DOCS, 'concepts', 'why-vx-is-fast.md'), 'utf8')
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    for (const claim of ['16–25 ms per 1,000 configs', 'against ~200 ms of evaluations']) {
      expect(flat(page)).toContain(claim)
      expect(flat(concept)).toContain(claim)
    }
    expect(bench).toContain('16–25 ms per')
    expect(bench).toContain('~199 ms')
  })
})

describe('the honest-benchmarks post quotes the benchmarks page', () => {
  const page = readFileSync(path.join(DOCS, 'blog', 'honest-benchmarks.md'), 'utf8')
  const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
  it('each figure it states is on docs/benchmarks.md as written', () => {
    // It spelled the cached and CPU figures its own way and rounded the
    // CPU trio (35 s for 34.61s, 73 s for 1m 13s), the fault items 336
    // and 340 fixed on two other posts (item 342, 2026-09-16).
    for (const figure of [
      '3m 38s',
      '3m 46s',
      '5m 13s',
      '34m 44s',
      '510ms',
      '760ms',
      '3.59s',
      '34.61s',
      '1m 13s',
      '114m 06s',
      '67ms',
      '40.6 s',
      '45.5 s',
      '66 ms',
      '127 ms',
      '51 ms',
      '95 ms',
      '53.6 s',
      '58.2 s',
      '80 ms',
      '166 ms',
      '59 ms',
      '93 ms',
    ]) {
      expect(page).toContain(figure)
      expect(bench).toContain(figure)
    }
  })
  it('the runners it names are the versions the benchmarks page ran', () => {
    for (const version of ['Turbo 2.10.12', 'Nx 23.2.0', 'Turbo 2.10.10']) {
      expect(page).toContain(version)
      expect(bench).toContain(version)
    }
  })
})

describe('the from-turborepo post maps every turbo.json key the mapper knows', () => {
  const src = readFileSync(
    path.resolve(import.meta.dir, '..', '..', 'vx-migrate', 'src', 'turbo', 'turbo-map.ts'),
    'utf8',
  )
  const page = readFileSync(path.join(DOCS, 'blog', 'from-turborepo.md'), 'utf8')
  it('every KNOWN_TASK_KEYS entry is named in its table', () => {
    const m = /const KNOWN_TASK_KEYS = new Set\(\[([^\]]*)\]/.exec(src)
    expect(m).not.toBeNull()
    const keys = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
    expect(keys.length).toBeGreaterThan(8)
    const table = page.slice(page.indexOf('| `turbo.json`'), page.indexOf('Three things you get'))
    // A row names the key alone (`extends`) or with the value it maps on
    // (`cache: false`), so the pin accepts either closing.
    for (const key of keys) expect(table).toMatch(new RegExp('`' + key + '(`|:)'))
  })
  it('the global fields it names are the ones the mapper reads', () => {
    const globals = [...src.matchAll(/rootCfg\.(global\w+)/g)].map((x) => x[1]!)
    expect(globals.length).toBe(3)
    for (const g of globals) expect(page).toContain('`' + g + '`')
  })
  it('what it says a bare `--continue` does is what run.ts does', () => {
    const run = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cli', 'run.ts'), 'utf8')
    expect(run).toContain("// Bare --continue = 'always' (the Turbo convention)")
    const scheduler = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'graph', 'scheduler.ts'),
      'utf8',
    )
    expect(scheduler).toContain("options.continueMode ?? 'deps-ok'")
    const flat = page.replace(/\s+/g, ' ')
    expect(flat).toContain('a vx run with no flag is `deps-ok`')
    expect(flat).toContain('bare `--continue` is `always`')
  })
})

describe('the from-nx post names every executor the migration infers', () => {
  const src = readFileSync(
    path.resolve(import.meta.dir, '..', '..', 'vx-migrate', 'src', 'migrate-nx.ts'),
    'utf8',
  )
  const page = readFileSync(path.join(DOCS, 'blog', 'from-nx.md'), 'utf8')
  it('each KNOWN_EXECUTORS key is in its list, counted as the list counts them', () => {
    const m = /const KNOWN_EXECUTORS: Record<[^>]*> = \{([\s\S]*?)\n\}/.exec(src)
    expect(m).not.toBeNull()
    const names = [...m![1]!.matchAll(/'(@nx\/[^']+)'/g)].map((x) => x[1]!)
    expect(names.length).toBe(8)
    for (const name of names) expect(page).toContain('`' + name + '`')
    expect(page).toContain('the eight executors')
    // The two persistent ones are a claim of its own.
    const persistent = [...m![1]!.matchAll(/'(@nx\/[^']+)': \{[^}]*persistent: true/g)].length
    expect(persistent).toBe(2)
    expect(page.replace(/\s+/g, ' ')).toContain('The two dev servers come through as persistent')
  })
  it('the benchmark figures it states are the benchmarks page’s', () => {
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    for (const figure of ['510ms', '3.59s', '34.61s', '114m 06s']) {
      expect(page).toContain(figure)
      expect(bench).toContain(figure)
    }
  })
  it('the cache wire it names is the one nx-cache speaks', () => {
    const cache = readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'vx-migrate', 'src', 'nx-cache', 'index.ts'),
      'utf8',
    )
    expect(cache).toContain('/v1/cache/${hash}')
    expect(page).toContain('`/v1/cache`')
  })
})

describe('the pipeline-with-seams post tabulates every stage a plugin can fill', () => {
  it('its table is PLUGIN_HOOKS, in order, and names no other stage', () => {
    // It listed eleven of the thirteen: `admit` was nowhere and `teardown`
    // rode in `setup`'s row (item 343, 2026-09-16) — the same shape PR #487
    // found in the what-vx-is post.
    const page = readFileSync(path.join(DOCS, 'blog', 'pipeline-with-seams.md'), 'utf8')
    const table = page.slice(page.indexOf('| Stage '), page.indexOf('A plugin is `definePlugin'))
    const rows = [...table.matchAll(/^\| `(\w+)` +\|/gm)].map((m) => m[1]!)
    expect(rows).toEqual([...PLUGIN_HOOKS])
  })
})

describe('the sandbox post names the whole permission surface', () => {
  const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'config.ts'), 'utf8')
  const page = readFileSync(path.join(DOCS, 'blog', 'the-sandbox.md'), 'utf8')
  it('every SandboxGrants key is in its list', () => {
    const decl = /export interface SandboxGrants \{([\s\S]*?)\n\}/.exec(src)
    expect(decl).not.toBeNull()
    const keys = [...decl![1]!.matchAll(/^  (\w+)\?:/gm)].map((m) => m[1]!)
    expect(keys.length).toBe(9)
    for (const key of keys) expect(page).toContain('`' + key + '`')
  })
  it('it names `deny` and `ignore` beside `allow`', () => {
    expect(src).toContain('deny?: SandboxDenials')
    expect(src).toContain('ignore?: SandboxGrants')
    for (const field of ['`allow`', '`deny`', '`ignore`']) expect(page).toContain(field)
  })
  it('the Linux binaries it names are the three the runtime checks for', () => {
    const runtime = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts'),
      'utf8',
    )
    const m = /'the sandbox runtime needs ([^']*) on PATH'/.exec(runtime)
    expect(m).not.toBeNull()
    // "bubblewrap (bwrap), socat and ripgrep (rg)" → the three binaries.
    const bins = [...m![1]!.matchAll(/\((\w+)\)|\b(socat)\b/g)].map((x) => x[1] ?? x[2]!)
    expect(bins.sort()).toEqual(['bwrap', 'rg', 'socat'])
    const flat = page.replace(/\s+/g, ' ')
    expect(flat).toContain('three binaries')
    for (const bin of bins) expect(flat).toContain('`' + bin + '`')
  })
})

describe('the remote-execution post states the placement rules core applies', () => {
  const placement = readFileSync(
    path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'placement.ts'),
    'utf8',
  )
  const page = readFileSync(path.join(DOCS, 'blog', 'remote-execution.md'), 'utf8')
  it('each field that pins a task local is one it lists', () => {
    const fn = placement.slice(
      placement.indexOf('export function pinnedLocalSet'),
      placement.indexOf('export interface Placements'),
    )
    for (const field of ['exec?.persistent', 'exec?.sandbox', 'exec?.remote === false']) {
      expect(fn).toContain(field)
    }
    expect(fn).toContain('node.deps.some((d) => visit(d))')
    const flat = page.replace(/\s+/g, ' ')
    expect(flat).toContain('Not persistent tasks, or anything depending on one')
    expect(flat).toContain('Not sandboxed tasks')
    expect(flat).toContain('Not `exec.remote: false`')
  })
  it('the `--dry` label it prints is the executor’s own name', () => {
    const exec = readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'vx-reapi', 'src', 'executor.ts'),
      'utf8',
    )
    const m = /^    name: '([^']+)',$/m.exec(exec)
    expect(m).not.toBeNull()
    expect(page).toContain('`@' + m![1]! + '`')
  })
})

describe('the config-in-typescript post shows what vx init writes', () => {
  const page = readFileSync(path.join(DOCS, 'blog', 'config-in-typescript.md'), 'utf8')
  it('its generated shape is the one migration.ts emits', () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'workspace', 'migration.ts'),
      'utf8',
    )
    expect(src).toContain("import type { ProjectConfig } from '@vzn/vx'")
    expect(src).toContain('} satisfies ProjectConfig')
    // The page's own snippet must carry the import it tells people to write.
    const block = fencedBlock(page, 'ts', '// packages/ui/vx.config.ts')
    expect(block).toContain("import type { ProjectConfig } from '@vzn/vx'")
    expect(block).toContain('satisfies ProjectConfig')
  })
  it('its runtime-import cost is the figure schema.md measured', () => {
    const schema = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
    const m = /\(~(\d+) ms on a two-package workspace,\n?measured/.exec(schema)
    expect(m).not.toBeNull()
    expect(page.replace(/\s+/g, ' ')).toContain(`~${m![1]} ms on a two-package workspace`)
  })
})

describe('the MCP guide and post state the server size the source has', () => {
  const server = readFileSync(
    path.resolve(import.meta.dir, '..', '..', 'vx-mcp', 'src', 'server.ts'),
    'utf8',
  )
  const lines = server.split('\n').length
  for (const [label, file] of [
    ['the guide', path.join(DOCS, 'guides', 'mcp.md')],
    ['the agents-and-mcp post', path.join(DOCS, 'blog', 'agents-and-mcp.md')],
  ] as const) {
    it(`${label}'s "about N lines" is within a rounding of server.ts`, () => {
      // Both said "about a hundred lines" of a 144-line file; item 339 fixed
      // the post's body and left its heading (item 345, 2026-09-16). A round
      // number is fine, a 30% one is not.
      const page = readFileSync(file, 'utf8')
      const m = /about (\d+) lines/.exec(page)
      expect(m).not.toBeNull()
      expect(Math.abs(Number(m![1]) - lines) / lines).toBeLessThan(0.15)
    })
  }
  it('the guide tabulates every tool the server offers', () => {
    const tools = readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'vx-mcp', 'src', 'tools.ts'),
      'utf8',
    )
    const names = [...tools.matchAll(/^    name: '(\w+)',$/gm)].map((m) => m[1]!)
    const page = readFileSync(path.join(DOCS, 'guides', 'mcp.md'), 'utf8')
    const rows = [...page.matchAll(/^\| `(\w+)` *\|/gm)].map((m) => m[1]!)
    expect(rows.sort()).toEqual([...names].sort())
  })
})

describe('the otel guide names attributes the exporter actually emits', () => {
  it('every `vx.<name>` it prints is one otlp.ts writes', () => {
    // Span names live beside the attribute map, so read the exporter's
    // sources, not one file of them.
    const otelSrc = path.resolve(import.meta.dir, '..', '..', 'vx-otel', 'src')
    const emitted = new Set(
      readdirSync(otelSrc)
        .filter((f) => f.endsWith('.ts'))
        .flatMap((f) => [
          ...readFileSync(path.join(otelSrc, f), 'utf8').matchAll(/'(vx\.[a-z_.]+)'/g),
        ])
        .map((m) => m[1]!),
    )
    expect(emitted.size).toBeGreaterThan(30)
    const page = readFileSync(path.join(DOCS, 'guides', 'otel-bridge.md'), 'utf8')
    // Backticked attribute names only, and not the prefixes it shows as
    // shapes (`vx.tag.<k>`, `vx.log.*`) or the workspace file's name.
    const named = [...page.matchAll(/`(vx\.[a-z_.]+)`/g)]
      .map((m) => m[1]!)
      .filter((n) => n !== 'vx.workspace.ts' && !n.endsWith('.'))
    expect(named.length).toBeGreaterThan(15)
    for (const attr of named) expect(emitted).toContain(attr)
  })
})

describe('the sandboxing guide counts the tasks that decline the sandbox', () => {
  it('its count is what this repo’s configs declare', () => {
    const stripStrings = (s: string) => s.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")
    const found: string[] = []
    const dir = path.resolve(import.meta.dir, '..', '..')
    for (const pkg of readdirSync(dir)) {
      const cfg = path.join(dir, pkg, 'vx.config.ts')
      if (!existsSync(cfg)) continue
      const src = stripStrings(readFileSync(cfg, 'utf8'))
      for (const m of src.matchAll(/^ {4}(?:''|[\w.$-]+): \{/gm)) {
        let depth = 1
        let i = m.index! + m[0].length
        while (depth > 0 && i < src.length) {
          if (src[i] === '{') depth++
          else if (src[i] === '}') depth--
          i++
        }
        const body = src.slice(m.index! + m[0].length, i)
        if (/\bexec: \{/.test(body) && !body.includes('sandbox')) found.push(pkg)
      }
    }
    // The parser must find the two CLAUDE.md names — if it finds none it is
    // broken, not the docs.
    expect(found.sort()).toEqual(['vx', 'vx-reapi'])
    const page = readFileSync(path.join(DOCS, 'guides', 'sandboxing.md'), 'utf8')
    expect(page.replace(/\s+/g, ' ')).toContain('exactly two tasks in this repository that do not')
    expect(page).toContain('`@vzn/vx-reapi#test`')
  })
})

describe('the workspace-config guide documents every WorkspaceConfig field', () => {
  it('each field of the interface has a section', () => {
    const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'config.ts'), 'utf8')
    const decl = /export interface WorkspaceConfig \{([\s\S]*?)\n\}/.exec(src)
    expect(decl).not.toBeNull()
    const fields = [...decl![1]!.matchAll(/^  (\w+)\?:/gm)].map((m) => m[1]!)
    expect(fields.length).toBe(4)
    const page = readFileSync(path.join(GUIDES, 'workspace-config.md'), 'utf8')
    // `plugins` is the page's subject — it shows it in every config block
    // rather than giving it a `## field` section of its own.
    expect(page).toContain('plugins: [')
    for (const field of fields.filter((f) => f !== 'plugins')) {
      expect(page).toContain('## `' + field + '`')
    }
  })
})

describe('the remote-caching guide names the seam core defines', () => {
  it('every RemoteCacheLayer method is named, the optional one as optional', () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'cache', 'layered-cache.ts'),
      'utf8',
    )
    const decl = /export interface RemoteCacheLayer \{([\s\S]*?)\n\}/.exec(src)
    expect(decl).not.toBeNull()
    const methods = [...decl![1]!.matchAll(/^  (\w+)(\??)\(/gm)].map((m) => ({
      name: m[1]!,
      optional: m[2] === '?',
    }))
    expect(methods.map((m) => m.name).sort()).toEqual(['get', 'has', 'hasMany', 'put'])
    const page = readFileSync(path.join(GUIDES, 'remote-caching.md'), 'utf8')
    for (const m of methods) expect(page).toContain('`' + m.name + '`')
    expect(methods.find((m) => m.name === 'hasMany')!.optional).toBe(true)
    expect(page.replace(/\s+/g, ' ')).toContain('an optional `hasMany`')
  })
})

describe('the CI guide states what --frozen measured, not what it once claimed', () => {
  it('its frozen figures are the benchmarks page’s head-to-head', () => {
    // It sold `--frozen` as "roughly 10–21%" off a warm run; the 2026-09-12
    // measurement reads the row as a tie (item 346, 2026-09-16).
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    expect(bench).toContain('plain min 154 / median 177 ms, frozen 148 / 165')
    const page = readFileSync(path.join(GUIDES, 'ci.md'), 'utf8').replace(/\s+/g, ' ')
    expect(page).toContain('median of 177 ms')
    expect(page).toContain('165')
    expect(page).not.toMatch(/10–21%/)
  })
})

describe('the caching guide lists what the cache never reads', () => {
  const page = readFileSync(path.join(GUIDES, 'caching.md'), 'utf8')
  it('its always-excluded list is ALWAYS_IGNORE', () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'cache', 'inputs.ts'),
      'utf8',
    )
    const arr = /const ALWAYS_IGNORE = \[([\s\S]*?)\n\]/.exec(src)
    expect(arr).not.toBeNull()
    // Comment lines inside the array quote globs of their own, so drop them
    // before reading the entries. `**/node_modules/**` → node_modules.
    const entries = arr![1]!
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    const names = [...entries.matchAll(/'\*\*\/([^']+?)(?:\/\*\*)?'/g)].map((m) => m[1]!)
    expect(names.length).toBe(6)
    const section = /## Outputs/.exec(page)
    expect(section).not.toBeNull()
    const excluded = page.slice(page.indexOf("What's always excluded"), section!.index)
    for (const name of names) expect(excluded).toContain(name)
  })
  it('its benchmark figures are the benchmarks page’s, as written', () => {
    const bench = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
    for (const figure of ['510ms', '760ms', '3.59s']) {
      expect(page).toContain(figure)
      expect(bench).toContain(figure)
    }
  })
})

describe('the tasks guide names every exec field a task can declare', () => {
  it('each ExecConfig field beyond `command` is in its list', () => {
    const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'config.ts'), 'utf8')
    const decl = /export interface ExecConfig \{([\s\S]*?)\n\}/.exec(src)
    expect(decl).not.toBeNull()
    const fields = [...decl![1]!.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]!)
    expect(fields).toContain('command')
    const page = readFileSync(path.join(GUIDES, 'tasks.md'), 'utf8')
    for (const field of fields.filter((f) => f !== 'command')) {
      expect(page).toContain('`exec.' + field + '`')
    }
  })
})

describe('cli.md lists the fields `vx show` prints', () => {
  it('every field name show.ts adds is named, and none it cannot print', () => {
    // It listed `resources`, which left the config on 2026-09-12 — a field
    // `vx show` has no way to print (item 347, 2026-09-16).
    const src = readFileSync(path.resolve(import.meta.dir, '..', 'src', 'cli', 'show.ts'), 'utf8')
    const added = new Set([...src.matchAll(/add\(\s*'([\w.]+)'/g)].map((m) => m[1]!))
    expect(added.size).toBeGreaterThan(5)
    const cli = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
    const para = cli.slice(
      cli.indexOf('`vx show <project>` prints a block per task'),
      cli.indexOf('Fields the\ntask does not set are not printed.'),
    )
    expect(para.length).toBeGreaterThan(100)
    for (const name of ['remote', 'sandbox', 'persistent', 'retries', 'timeout']) {
      expect(added).toContain(name)
      expect(para).toContain('`' + name + '`')
    }
    expect(added.has('resources')).toBe(false)
    expect(para).not.toContain('`resources`')
  })
})

describe('the dev-tasks guide bounds the teardown the way signals.ts does', () => {
  it('its grace is SIGNAL_SHUTDOWN_GRACE_MS', () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'signals.ts'),
      'utf8',
    )
    const m = /export const SIGNAL_SHUTDOWN_GRACE_MS = (\d+)/.exec(src)
    expect(m).not.toBeNull()
    expect(src).toContain("killTree(child, 'SIGKILL')")
    const page = readFileSync(path.join(GUIDES, 'dev-tasks.md'), 'utf8').replace(/\s+/g, ' ')
    expect(page).toContain(`${Number(m![1]) / 1000}-second grace`)
    expect(page).toContain('`SIGKILL`ed')
  })
})

describe('the task-dependencies guide uses the status words the scheduler sets', () => {
  it('a failed upstream skips its dependents; aborted is the teardown status', () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'graph', 'scheduler.ts'),
      'utf8',
    )
    // Both words are statuses of TaskOutcome, and they are not the same one.
    for (const status of ["'skipped'", "'aborted'"]) expect(src).toContain(status)
    const page = readFileSync(path.join(GUIDES, 'task-dependencies.md'), 'utf8').replace(
      /\s+/g,
      ' ',
    )
    expect(page).toContain('skips its transitive dependents')
    expect(page).not.toContain('aborts its transitive dependents')
    for (const mode of ['deps-ok', 'never', 'always']) {
      expect(page).toContain('`--continue=' + mode + '`')
    }
  })
})
