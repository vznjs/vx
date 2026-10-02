// Module pages a fix left behind: the commit updated cli.md or caching.md
// and the page for the file it changed kept the old claim. Each row holds
// one page to what its code now does.
import { readFileSync } from 'node:fs'
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
