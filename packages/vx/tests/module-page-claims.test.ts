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

  it("logger.md: a kept server's output streams under its id after the summary (#2054)", () => {
    expect(src('orchestrator/logger.ts')).toContain('formatKeptLines(')
    expect(page('modules/logger.md')).toMatch(
      /streams below the summary a line at a time under its id/,
    )
  })
})
