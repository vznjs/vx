// The plugin hook list has ONE source, `PLUGIN_HOOKS` (config.ts); the
// docs that tabulate the hooks are held to it here, the way schema.md's
// error table is held to the loader. `admit` reached two of these tables a
// day after the hook existed (2026-09-12) because nothing read them.
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_HOOKS } from '../src/config.js'

const DOCS = path.resolve(import.meta.dir, '..', 'docs')
/** The lifecycle pair is prose, not a stage, in the stage tables. */
const LIFECYCLE = new Set(['setup', 'teardown'])

/** Hook names in backticks at the start of a table row: `name`, `name(args)`. */
async function tabulatedHooks(file: string): Promise<Set<string>> {
  const text = await Bun.file(path.join(DOCS, file)).text()
  const out = new Set<string>()
  for (const m of text.matchAll(/^\|\s*`([a-z]+)(?:\(|`)/gm)) out.add(m[1]!)
  return out
}

/** Hook names in backticks in a table's second column (the pipeline design's shape). */
async function secondColumnHooks(file: string): Promise<Set<string>> {
  const text = await Bun.file(path.join(DOCS, file)).text()
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|')
    const cell = cells[2] ?? ''
    for (const m of cell.matchAll(/`([a-z]+)(?:\(|`)/g)) out.add(m[1]!)
  }
  return out
}

describe('the plugin hook tables follow PLUGIN_HOOKS', () => {
  it('architecture.md tabulates every stage (the lifecycle pair is prose)', async () => {
    const found = await tabulatedHooks('architecture.md')
    for (const hook of PLUGIN_HOOKS) if (!LIFECYCLE.has(hook)) expect(found).toContain(hook)
  })

  it('modules/plugin.md tabulates every hook', async () => {
    const found = await tabulatedHooks('modules/plugin.md')
    for (const hook of PLUGIN_HOOKS) expect(found).toContain(hook)
  })

  it('design/pipeline-2026-09.md names every hook in its stage table', async () => {
    const found = await secondColumnHooks('design/pipeline-2026-09.md')
    for (const hook of PLUGIN_HOOKS) expect(found).toContain(hook)
  })

  it('CONTROL: a table that lacks a hook is caught', async () => {
    // The extractor sees exactly what the rows say: a table without `admit`
    // fails the check above, so a passing run is evidence, not vacuity.
    const text = await Bun.file(path.join(DOCS, 'modules/plugin.md')).text()
    const without = text.replace(/^\|\s*`admit\(.*$/m, '')
    const out = new Set<string>()
    for (const m of without.matchAll(/^\|\s*`([a-z]+)(?:\(|`)/gm)) out.add(m[1]!)
    expect(out).not.toContain('admit')
    expect(out).toContain('schedule')
  })
})
