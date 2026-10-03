// The plugin hooks are a 1.0 contract (PLUGIN_HOOKS, config.ts), and three
// pages tabulate them. plugin-hooks-doc-drift requires each table to name
// every hook; this holds the rest: the hook table holds exactly
// PLUGIN_HOOKS (a row for a hook that does not exist fails), and the
// pipeline stages, `config` through `telemetry`, run in the order a run
// calls them. Both tables listed `executor` first, before `config`.
// `commands` and the `setup` / `teardown` pair are not stages, so their
// place in a table is the page's own.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_HOOKS } from '../src/config.js'

const DOCS = path.resolve(import.meta.dir, '..', 'docs')
const STAGES = PLUGIN_HOOKS.slice(0, PLUGIN_HOOKS.indexOf('telemetry') + 1)
const LIFECYCLE = ['setup', 'teardown']

/** The table holding the `admit` row: each row's hook names, from the given column. */
function hookTable(text: string, column: number): string[] {
  const lines = text.split('\n')
  const at = lines.findIndex(
    (l) => l.startsWith('|') && /`admit(?:\(|`)/.test(l.split('|')[column] ?? ''),
  )
  expect(at).toBeGreaterThan(-1)
  let start = at
  while (start > 0 && lines[start - 1]!.startsWith('|')) start--
  let end = at
  while (end + 1 < lines.length && lines[end + 1]!.startsWith('|')) end++
  return lines
    .slice(start, end + 1)
    .flatMap((l) =>
      [...(l.split('|')[column] ?? '').matchAll(/`([a-z]+)(?:\(|`)/g)].map((m) => m[1]!),
    )
}

const PAGES = [
  // architecture.md says the lifecycle pair in prose below its table.
  {
    file: 'architecture.md',
    column: 1,
    expected: PLUGIN_HOOKS.filter((h) => !LIFECYCLE.includes(h)),
  },
  { file: 'modules/plugin.md', column: 1, expected: [...PLUGIN_HOOKS] },
  { file: 'design/pipeline-2026-09.md', column: 2, expected: [...PLUGIN_HOOKS] },
]

describe('each hook table is PLUGIN_HOOKS, stages in run order', () => {
  it('reads the table holding admit, and only it', () => {
    const text = '| `a` |\n\n| x | `config` |\n| x | `admit(t)` |\n| x | `cache` |\n\n| `b` |\n'
    expect(hookTable(text, 2)).toEqual(['config', 'admit', 'cache'])
  })

  it.each(PAGES)('$file names exactly the hooks', ({ file, column, expected }) => {
    const found = hookTable(readFileSync(path.join(DOCS, file), 'utf8'), column)
    expect([...found].sort()).toEqual([...expected].sort())
  })

  it.each(PAGES)('$file lists the stages in run order', ({ file, column }) => {
    const found = hookTable(readFileSync(path.join(DOCS, file), 'utf8'), column)
    expect(found.filter((h) => (STAGES as readonly string[]).includes(h))).toEqual([...STAGES])
  })
})
