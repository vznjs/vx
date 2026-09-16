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
import { CACHE_VERSION, SCHEMA_VERSION } from '../src/cache/index.js'
import { formatRunSummary } from '../src/orchestrator/summary.js'
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
  const src = await Bun.file(new URL('../src/cli/run.ts', import.meta.url).pathname).text()
  return new Set(Array.from(src.matchAll(/'(--[a-zA-Z][a-zA-Z-]*)=?'/g), (m) => m[1] as string))
}

/** Flag names in the `### Flags` table of docs/cli.md, one per row. */
async function documentedFlags(): Promise<Set<string>> {
  const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url).pathname).text()
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
    const help = await Bun.file(new URL('../src/cli/help.ts', import.meta.url).pathname).text()
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
    const doc = await Bun.file(new URL('../docs/comparison.md', import.meta.url).pathname).text()
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
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url).pathname).text()
    // The renderer pads every label to the widest; the sample is its output.
    expect(doc).toMatch(
      new RegExp(
        `^cache versions:\\s+keys ${CACHE_VERSION} · index schema ${SCHEMA_VERSION}$`,
        'm',
      ),
    )
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
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url).pathname).text()
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
    const doc = await Bun.file(new URL('../docs/cli.md', import.meta.url).pathname).text()
    const marker = 'copy/paste yields the verbatim output.'
    // The block sits just above that sentence: take the fenced block that precedes it.
    const end = doc.lastIndexOf('\n```\n', doc.indexOf(marker))
    const start = doc.lastIndexOf('```\n', end - 1) + 4
    expect(start).toBeGreaterThan(4)
    expect(doc.slice(start, end)).toBe(rendered)
  })
})
