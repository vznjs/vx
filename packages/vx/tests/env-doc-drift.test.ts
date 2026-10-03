// docs/cli.md § Environment variables is the one place a user finds what
// `VX_*` means. Nothing tied it to the source until item 614: two of the
// six variables core read were documented nowhere a user looks
// (`VX_WATCH_POLL` in two history files, `VX_CONFIG_WORKER_TIMEOUT_MS` in
// a code comment). Same shape as cli-doc-drift's Flags table: the set the
// source reads against the set the table names, one assertion, both
// directions, so neither an undocumented variable nor a documented ghost
// lands quietly. The source of truth is the `process.env` reads themselves,
// not a list a test could agree with.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { readInSource } from './helpers/env-reads.js'

const pkg = path.resolve(import.meta.dir, '..')

function documented(): Set<string> {
  const doc = readFileSync(path.join(pkg, 'docs', 'cli.md'), 'utf8')
  const start = doc.indexOf('## Environment variables vx reads')
  expect(start).toBeGreaterThan(-1)
  const names = new Set<string>()
  for (const line of doc.slice(start).split('\n')) {
    // A row may name two variables set and read together.
    const cell = /^\| ((?:`VX_[A-Z0-9_]+`(?:, )?)+) /.exec(line)
    if (cell !== null) {
      for (const m of cell[1]!.matchAll(/`(VX_[A-Z0-9_]+)`/g)) names.add(m[1]!)
      continue
    }
    if (names.size > 0) break
  }
  return names
}

describe('docs/cli.md § Environment variables vx reads matches what core reads', () => {
  it('names every VX_ variable the source reads, and no others', () => {
    const source = readInSource()
    expect(source.size).toBeGreaterThan(4)
    expect([...documented()].sort()).toEqual([...source].sort())
  })
})

// The section said "the variables core reads" and named no CI variable,
// though `CI` and `GITHUB_ACTIONS` pick the output and the provider list
// fills the invocation row (J2-63). Read from both sources.
describe('docs/cli.md § Environment variables names the CI variables core reads', () => {
  it('names each one the output view and the CI detection read', () => {
    const src = (rel: string): string => readFileSync(path.join(pkg, 'src', rel), 'utf8')
    const logger = src('orchestrator/logger.ts')
    const view = logger.slice(logger.indexOf('export function resolveOutputView('))
    const read = new Set(
      Array.from(view.slice(0, view.indexOf('\n}\n')).matchAll(/env\['(\w+)'\]/g), (m) => m[1]!),
    )
    const ctx = src('orchestrator/run-context.ts')
    const list = ctx.slice(
      ctx.indexOf('const CI_PROVIDERS'),
      ctx.indexOf('\n]\n', ctx.indexOf('const CI_PROVIDERS')),
    )
    for (const m of list.matchAll(/\['(\w+)', '\w+'\]/g)) read.add(m[1]!)
    expect(read.has('CI') && read.has('GITHUB_ACTIONS') && read.has('CIRCLECI')).toBe(true)
    const doc = readFileSync(path.join(pkg, 'docs', 'cli.md'), 'utf8')
    const start = doc.indexOf('## Environment variables vx reads')
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1))
    expect([...read].filter((v) => !section.includes(`\`${v}\``))).toEqual([])
  })
})

// The task's PATH prefix is stated on several pages. #2192 left a bin
// directory holding the delimiter out of PATH and updated two of them;
// env.md still said every entry is prepended, and execute-task.md named
// the project's bin alone though the workspace root's is prepended too.
describe('every page stating the PATH prefix states all of it', () => {
  /** The paragraphs (and list items) of a page that say a bin is prepended. */
  const prefixBlocks = (rel: string): string[] =>
    readFileSync(path.join(pkg, 'docs', rel), 'utf8')
      .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
      .map((b) => b.split(/\s+/).join(' '))
      .filter((b) => b.includes('node_modules/.bin') && /prepend/.test(b))

  const PAGES = [
    'execution.md',
    'schema.md',
    'architecture.md',
    'modules/env.md',
    'modules/execute-task.md',
  ]

  it.each(PAGES)("%s names the workspace root's bin beside the project's", (rel) => {
    const blocks = prefixBlocks(rel)
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks)
      expect(b).toMatch(/<workspaceRoot>\/node_modules\/\.bin|(?:WORKSPACE ROOT|workspace root)'s/)
  })

  it.each(['execution.md', 'schema.md', 'modules/env.md'])(
    '%s says a bin directory holding the delimiter is left out',
    (rel) => {
      expect(prefixBlocks(rel).join(' ')).toMatch(/delimiter.{0,40} (?:is )?left out/)
    },
  )
})
