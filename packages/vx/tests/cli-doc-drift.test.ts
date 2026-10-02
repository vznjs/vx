// `docs/cli.md`'s Flags table is the reference a user scans to find out what
// `vx run` accepts. Nothing tied it to the parser, and this pair has drifted
// before in both directions: the doc once promised `=` forms the parser
// rejected, and it carried three bullets describing flags that had already
// shipped. Writing this guard found a third — `--continue` was parsed and had
// its own section, but no row in the table.
//
// Same idea as tests/schema-doc-drift.test.ts: compare the two sets in one
// assertion so neither direction can drift quietly. An undocumented flag is
// the more valuable catch, since a flag nobody documents is a flag nobody
// finds.

import { describe, expect, it } from 'bun:test'
import { PLUGIN_HOOKS } from '../src/config.js'
import { CACHE_VERSION, SCHEMA_VERSION } from '../src/cache/index.js'
import { formatRunSummary } from '../src/orchestrator/summary.js'
import { formatRunReportMarkdown } from '../src/orchestrator/run-report.js'
import {
  formatTaskBlock,
  formatTaskExecutedLine,
  formatTaskHitLine,
} from '../src/orchestrator/framed-output.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'

/**
 * Flags the parser compares against. `parseRunArgs` matches every flag as a
 * string literal (`a === '--x' || a?.startsWith('--x=')`), which is what makes
 * reading them out of the source reliable rather than clever. If that ever
 * becomes a computed lookup this needs to read the table instead — the assert
 * failing loudly is the intended outcome, not a silent pass.
 */
async function parserFlags(): Promise<Set<string>> {
  const src = await Bun.file(new URL('../src/cli/run.ts', import.meta.url)).text()
  return new Set(Array.from(src.matchAll(/'(--[a-zA-Z][a-zA-Z-]*)=?'/g), (m) => m[1] as string))
}

/** Flag names in the `### Flags` table of docs/cli.md, one per row. */
async function documentedFlags(): Promise<Set<string>> {
  const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
  const start = doc.indexOf('### Flags')
  expect(start).toBeGreaterThan(-1)
  const names = new Set<string>()
  for (const line of doc.slice(start).split('\n')) {
    const m = /^\| `(--[a-zA-Z][a-zA-Z-]*)/.exec(line)
    if (m !== null) {
      names.add(m[1] as string)
      continue
    }
    // The first non-row line past the header/separator ends the table.
    if (names.size > 0) break
  }
  return names
}

describe('vx help names every flag the run parser accepts', () => {
  // Four flags (--continue, --report, --report-file, --tag) were parsed and
  // documented in cli.md but absent from `vx help` until 2026-09-16 (item
  // 300): the reference was pinned to the parser, the help was not.
  it('every parser flag appears in help.ts', async () => {
    const help = await Bun.file(new URL('../src/cli/help.ts', import.meta.url)).text()
    const missing = [...(await parserFlags())]
      .filter((f) => !new RegExp(`${f}(?![a-zA-Z-])`).test(help))
      .sort()
    expect(missing).toEqual([])
  })
})

describe('docs/comparison.md names only flags vx has', () => {
  // The flag map's vx column and the callout under it are prose nobody
  // parsed; the callout named the retired --excludeDependencies until
  // 2026-09-16 (item 308).
  it('every --flag in the Quick CLI flag map section is a parser flag (or --version / --help)', async () => {
    const doc = await Bun.file(new URL('../docs/comparison.md', import.meta.url)).text()
    const start = doc.indexOf('## Quick CLI flag map')
    const end = doc.indexOf('## Config schema comparison')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const section = doc.slice(start, end)
    // --parallel is named as the flag vx deliberately does not have.
    const known = new Set([...(await parserFlags()), '--version', '--help', '--parallel'])
    const named = new Set<string>()
    for (const line of section.split('\n')) {
      // Only vx's cell of a table row (the last), plus the callout paragraphs.
      const cell = line.startsWith('|')
        ? (line.split('|').at(-2) ?? '')
        : line.startsWith('>')
          ? line
          : ''
      for (const m of cell.matchAll(/`(--[a-z][a-zA-Z-]*)/g)) named.add(m[1]!)
    }
    expect(named.size).toBeGreaterThan(10)
    expect([...named].filter((f) => !known.has(f)).sort()).toEqual([])
  })
})

describe('docs/cli.md Flags table matches the run parser', () => {
  it('documents every flag the parser accepts, and no others', async () => {
    const parsed = await parserFlags()
    const documented = await documentedFlags()
    expect(parsed.size).toBeGreaterThan(10)
    // Named separately so a failure says WHICH direction drifted rather than
    // dumping two sets and leaving the reader to diff them.
    const undocumented = [...parsed].filter((f) => !documented.has(f)).sort()
    const unparsed = [...documented].filter((f) => !parsed.has(f)).sort()
    expect({ undocumented, unparsed }).toEqual({ undocumented: [], unparsed: [] })
  })
})

describe('docs/cli.md — the `vx info` sample quotes the current versions', () => {
  it('cache versions row', async () => {
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    // The renderer pads every label to the widest; the sample is its output.
    expect(doc).toMatch(
      new RegExp(
        `^cache versions:\\s+keys ${CACHE_VERSION} · index schema ${SCHEMA_VERSION}$`,
        'm',
      ),
    )
  })
})

// The `--format json` bullet is the one list of what a script can read from
// `vx info`, and it had lost two fields by 2026-09-27: `bunSupported` and
// `sandbox` were printed and named nowhere. Both sides are read from their
// source: the `InfoFacts` interface in doctor.ts (what the object carries),
// and the bullet's backticked names.
describe('docs/cli.md — the `vx info --format json` list is the InfoFacts object', () => {
  it('names every top-level field, and nothing the object does not carry', async () => {
    // An interface's body, doc comments dropped: `FlakyTask` is the
    // element type `flakyTasks` names, declared in failure-mode.ts.
    const body = async (file: string, name: string): Promise<string> => {
      const src = await Bun.file(new URL(`../src/orchestrator/${file}`, import.meta.url)).text()
      const open = src.indexOf(`export interface ${name} {`)
      expect(open).toBeGreaterThan(-1)
      return src.slice(open, src.indexOf('\n}\n', open)).replace(/\/\*\*[\s\S]*?\*\//g, '')
    }
    const code = await body('doctor.ts', 'InfoFacts')
    const nested = code + (await body('failure-mode.ts', 'FlakyTask'))
    const topLevel = new Set(Array.from(code.matchAll(/^ {2}(\w+)\??:/gm), (m) => m[1] as string))
    // Nested keys and literal members are what the bullet's parentheses
    // describe (`workers.source` one of `workspace` / `cgroup` / `cores`).
    const anyKey = new Set(Array.from(nested.matchAll(/(\w+)\??:/g), (m) => m[1] as string))
    const literals = new Set(Array.from(code.matchAll(/'(\w+)'/g), (m) => m[1] as string))
    expect(topLevel.has('vx') && topLevel.has('sandbox')).toBe(true)

    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    const start = doc.indexOf('- `--format json` prints the same facts')
    expect(start).toBeGreaterThan(-1)
    // The bullet ends at the next bullet or, when it is the section's
    // last, at the next heading.
    const ends = ['\n- ', '\n## '].map((s) => doc.indexOf(s, start + 1)).filter((i) => i >= 0)
    const bullet = doc.slice(start, Math.min(...ends))
    const named = new Set(Array.from(bullet.matchAll(/`(\w+)`/g), (m) => m[1] as string))
    for (const shape of bullet.matchAll(/`[[{][^`]*`/g)) {
      for (const k of shape[0].matchAll(/\w+/g)) named.add(k[0])
    }

    const undocumented = [...topLevel].filter((k) => !named.has(k)).sort()
    const unknown = [...named].filter((k) => !anyKey.has(k) && !literals.has(k)).sort()
    expect({ undocumented, unknown }).toEqual({ undocumented: [], unknown: [] })
  })
})

// The broad-run sample is the one picture of a run the reference gives, and
// it had drifted three ways from the renderer by 2026-09-16: the rule's
// label sat at the right end (the renderer leads with it), the time line
// read `5.34s (max … · avg … · min …)` (the renderer joins with `·`), and
// the spread averaged the hit's 4 ms restore in — the very pollution the
// spread excludes by design. Render the same run and compare byte for byte.
describe('docs/cli.md — the broad-run sample is what the renderer prints', () => {
  const node = (id: string): TaskNode =>
    ({
      id,
      projectName: id.split('#')[0],
      taskName: id.split('#')[1],
      config: { exec: { command: 'x' }, cache: { inputs: { files: [] }, outputs: { files: [] } } },
    }) as unknown as TaskNode

  it('two rows and the footer, byte for byte', async () => {
    const hit: TaskOutcome = {
      node: node('@vzn/vx#format-check'),
      status: 'cache-hit',
      exitCode: 0,
      durationMs: 4,
      restored: true,
      storedDurationMs: 900,
    }
    const ran: TaskOutcome = {
      node: node('@vzn/vx#test'),
      status: 'success',
      exitCode: 0,
      durationMs: 5200,
    }
    const rendered = [
      formatTaskHitLine(hit.node, hit),
      formatTaskExecutedLine(ran.node, ran),
      ...formatRunSummary(
        [hit, ran],
        5340,
        { enabled: false },
        {
          version: '0.0.0',
          packageCount: 1,
          remoteCacheEnabled: false,
          concurrency: 8,
          workspaceProjectCount: 3,
        },
      ),
    ].join('\n')
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    const marker = 'A broad run looks like:\n\n```\n'
    const start = doc.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const body = doc.slice(start + marker.length)
    expect(body.slice(0, body.indexOf('\n```\n'))).toBe(rendered)
  })
})

// The frame anatomy was a hand-drawn sketch of a frame the renderer stopped
// printing: a `├─ command` label (the command is a bare dim `$ cmd` line),
// lowercase `├─ stdout` (the sections are `├─ STDOUT ──…`), no blank lines.
// The page now shows one real failed block with every section; render it.
describe('docs/cli.md — the frame sample is what the renderer prints', () => {
  it('a failed block with command, stdout, stderr and a violation, byte for byte', async () => {
    const node = {
      id: 'app#test',
      projectName: 'app',
      taskName: 'test',
      config: {
        exec: { command: 'bun test', sandbox: { allow: { read: ['**/*'] } } },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
    } as unknown as TaskNode
    const outcome: TaskOutcome = {
      node,
      status: 'failed',
      exitCode: 1,
      durationMs: 2100,
      hash: 'abc1234567',
      sandboxViolations: 1,
      sandboxViolationLines: ['write ../shared/notes.txt'],
    }
    const rendered = formatTaskBlock(
      node,
      outcome,
      { stdout: '2 pass\n1 fail\n', stderr: 'error: expected 3, got 2\n' },
      { enabled: false },
    ).replace(/\n$/, '')
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    const marker = 'copy/paste yields the verbatim output.'
    // The block sits just above that sentence: take the fenced block that precedes it.
    const end = doc.lastIndexOf('\n```\n', doc.indexOf(marker))
    const start = doc.lastIndexOf('```\n', end - 1) + 4
    expect(start).toBeGreaterThan(4)
    expect(doc.slice(start, end)).toBe(rendered)
  })
})

// The report sample's "8ms saved" was its hits' restore times, 5 + 3: the
// sum the paragraph under it says the header does not take. Render it.
describe('docs/cli.md — the --report sample is what the renderer prints', () => {
  it('the header and table, with the hits saving what their entries stored', async () => {
    const rendered = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        { taskId: 'web#build', status: 'success', exitCode: 0, durationMs: 1230 },
        {
          taskId: 'web#test',
          status: 'cache-hit',
          exitCode: 0,
          durationMs: 5,
          restored: true,
          storedDurationMs: 2010,
        },
        {
          taskId: 'api#test',
          status: 'cache-hit',
          exitCode: 0,
          durationMs: 3,
          restored: false,
          storedDurationMs: 640,
        },
      ],
    })
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    const start = doc.indexOf('```markdown\n## vx run — passed\n')
    expect(start).toBeGreaterThan(-1)
    const sample = doc.slice(start + 12, doc.indexOf('\n```\n', start) + 1)
    // The page's formatter pads the table; the cells are what is compared.
    const cells = (md: string): string[] =>
      md.split('\n').map((l) =>
        l.startsWith('|')
          ? l
              .split('|')
              .map((c) => (/^\s*-+\s*$/.test(c) ? '---' : c.trim()))
              .join('|')
          : l,
      )
    expect(cells(sample)).toEqual(cells(rendered))
  })
})

describe('docs/cli.md documents every verb the dispatcher answers', () => {
  // The Flags table has been pinned since item 308; the VERB list never was,
  // and it is the same shape — a list in prose beside a list in code. Read
  // whole at item 356 (2026-09-19): the `Top-level shape` synopsis, the one
  // place the reference enumerates the verbs, had lost `vx why` and `vx last`
  // — both with full sections further down, neither reachable by scanning the
  // index. Hold the synopsis to the dispatcher so the next verb lands in both.
  const read = (rel: string): Promise<string> => Bun.file(new URL(rel, import.meta.url)).text()

  /** The fenced block under `## Top-level shape`, Core and Meta together. */
  async function synopsis(): Promise<string> {
    const cli = await read('../docs/cli.md')
    const marker = '## Top-level shape\n\n```\n'
    const start = cli.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const body = cli.slice(start + marker.length)
    return body.slice(0, body.indexOf('\n```\n'))
  }

  it('every `case` in the dispatcher has a synopsis line', async () => {
    const dispatcher = await read('../src/cli/index.ts')
    // Four-space indent in the dispatcher's switch. `--help`/`-h`/`--version`
    // are flag spellings, not verbs, so the class is [a-z]+; the synopsis
    // names them in its Meta block anyway.
    const verbs = [...dispatcher.matchAll(/^    case '([a-z]+)':/gm)].map((m) => m[1]!)
    expect(verbs.length).toBeGreaterThan(10)
    const lines = new Set((await synopsis()).split('\n').map((l) => l.trim()))
    const missing = verbs.filter(
      (v) => ![...lines].some((l) => l === `vx ${v}` || l.startsWith(`vx ${v} `)),
    )
    expect(missing.sort()).toEqual([])
  })

  it('the synopsis invents no verb the dispatcher does not answer', async () => {
    const dispatcher = await read('../src/cli/index.ts')
    const verbs = new Set(
      [...dispatcher.matchAll(/^    case '(--)?([a-z-]+)':/gm)].map((m) => m[2]!),
    )
    const named = new Set<string>()
    for (const line of (await synopsis()).split('\n')) {
      const m = /^vx (--)?([a-z-]+)/.exec(line.trim())
      if (m !== null) named.add(m[2]!)
    }
    expect(named.size).toBeGreaterThan(10)
    expect([...named].filter((v) => !verbs.has(v)).sort()).toEqual([])
  })

  it('every verb core moved out keeps its section and its pointer', async () => {
    const cli = await read('../docs/cli.md')
    const moved = await read('../src/util/verbs.ts')
    const block = /MOVED_VERBS: Readonly<Record<string, string>> = \{([\s\S]*?)\n\}/.exec(moved)
    expect(block).not.toBeNull()
    const names = [...block![1]!.matchAll(/^  (\w+):/gm)].map((m) => m[1]!)
    expect(names.sort()).toEqual(['migrate', 'prune', 'stats'])
    for (const name of names) {
      // The doc keeps the section (people search for the verb) and says it
      // is gone, rather than dropping it and leaving a dead end.
      expect(cli).toContain(`## \`vx ${name}\``)
    }
  })
})

describe("`vx help`'s usage lines are cli.md's", () => {
  it('each verb line in the Usage block is the line in cli.md § Top-level shape, and back', async () => {
    // Nothing held the two: help showed `vx why [TASK | PKG#TASK]` for a
    // required target and `vx run [TASK | PKG#TASK]` for several, where
    // cli.md had it right (J-54, E-91). The meta spellings (`vx --help`,
    // `vx --version`) are cli.md's alone; a `# comment` is prose.
    const { helpText } = await import('../src/cli/help.js')
    const help = helpText().split('\n')
    const from = help.indexOf('Usage:')
    expect(from).toBeGreaterThan(-1)
    const shown: string[] = []
    for (const line of help.slice(from + 1)) {
      if (line === '') break
      shown.push(line.trim())
    }
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    const at = doc.indexOf('## Top-level shape')
    expect(at).toBeGreaterThan(-1)
    const open = doc.indexOf('```\n', at) + 4
    const block = doc.slice(open, doc.indexOf('\n```', open))
    const documented = block
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trim())
      .filter((l) => l.startsWith('vx ') && !l.startsWith('vx -'))
    expect(shown.length).toBeGreaterThan(10)
    expect([...shown].sort()).toEqual([...documented].sort())
  })
})

describe("vx info's plugins row lists the seams the doctor shows", () => {
  // The doc's list left out `discover`, which `vx info` prints for turbo()
  // and nx() (J-105). The doctor shows every hook but `teardown`.
  it('the parenthesised list is PLUGIN_HOOKS without teardown, in order', async () => {
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url)).text()
    const list = /each fills, in pipeline order \(([^)]*)\)/.exec(doc.replace(/\s+/g, ' '))![1]!
    const named = [...list.matchAll(/`(\w+)`/g)].map((m) => m[1]!)
    const doctor = await Bun.file(new URL('../src/orchestrator/doctor.ts', import.meta.url)).text()
    expect(doctor).toContain("const SEAMS = PLUGIN_HOOKS.filter((h) => h !== 'teardown')")
    expect(named).toEqual(PLUGIN_HOOKS.filter((h) => h !== 'teardown'))
  })
})
