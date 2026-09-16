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
import { formatTaskExecutedLine, formatTaskHitLine } from '../src/orchestrator/framed-output.js'
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
