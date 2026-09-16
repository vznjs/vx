// The site's guides show terminal output "as it prints"; a sample nobody
// renders drifts (the formatter's own docblock showed a glyph it never
// wrote, item 302, 2026-09-16). Each sample here is rendered with the
// real formatter and compared byte for byte. The site
// lives outside packages/vx, which a sandboxed shard cannot read — hence
// the unsafe suite (the site's own tests reach only the public API).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { formatPlanText } from '../src/cli/plan-format.js'
import { formatTaskHitLine } from '../src/orchestrator/framed-output.js'
import { formatFlakySection } from '../src/orchestrator/summary.js'
import { localExecutor } from '../src/exec/local-executor.js'
import { CACHE_LAYER_METHODS } from '../src/orchestrator/plugin-host.js'
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
  it('every verdict sentence metrics.ts can print is a row of its table', () => {
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
    for (const note of notes) expect(guide).toContain(note)
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
  it('every ALWAYS_IGNORE directory is in its list', () => {
    const page = readFileSync(path.join(DOCS, 'blog', 'strict-output-ownership.md'), 'utf8')
    const section = /## What the wipe never touches\n([\s\S]*?)\n## /.exec(page)
    expect(section).not.toBeNull()
    const src = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'cache', 'inputs.ts'),
      'utf8',
    )
    const arr = /const ALWAYS_IGNORE = \[([\s\S]*?)\n\]/.exec(src)
    expect(arr).not.toBeNull()
    const names = [...arr![1]!.matchAll(/'\*\*\/([^/']+)\/\*\*'/g)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(2)
    for (const name of names) expect(section![1]!).toContain('`' + name + '`')
  })
})
