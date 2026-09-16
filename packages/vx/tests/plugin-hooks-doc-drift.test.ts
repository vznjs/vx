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

  // The root README's maturity table states the hook count in prose, and
  // said 9 for a list of 13 until 2026-09-16 (item 283): nothing read it.
  it('the README states the hook count PLUGIN_HOOKS has', async () => {
    const readme = await Bun.file(
      path.resolve(import.meta.dir, '..', '..', '..', 'README.md'),
    ).text()
    const m = /Plugin pipeline \((\d+) hooks, `commands` included\)/.exec(readme)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(PLUGIN_HOOKS.length)
  })

  // The technical README's § 5 walks the pipeline in prose and named 8
  // of 13 hooks as "a hook at every stage" until 2026-09-16 (item 292).
  it('README.md § 5 names every hook', async () => {
    const text = await Bun.file(path.join(DOCS, 'README.md')).text()
    const section = /### 5\. [^\n]*\n([\s\S]*?)\n## /.exec(text)
    expect(section).not.toBeNull()
    const named = new Set([...section![1]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!))
    for (const hook of PLUGIN_HOOKS) expect(named).toContain(hook)
  })

  // schema.md's `plugins` bullet walked the hooks in prose and named 10 of
  // 13 — with its code spans wrapped into garbage on the site — until
  // 2026-09-16 (item 299).
  it('schema.md § Workspace config names every hook in the plugins bullet', async () => {
    const text = await Bun.file(path.join(DOCS, 'schema.md')).text()
    const m = /- \*\*`plugins`\*\*([\s\S]*?)\n\n/.exec(text)
    expect(m).not.toBeNull()
    const named = new Set([...m![1]!.matchAll(/`([a-z]+)`/g)].map((x) => x[1]!))
    for (const hook of PLUGIN_HOOKS) expect(named).toContain(hook)
  })

  // comparison.md's "plugin pipeline" bullet named five of thirteen hooks
  // until 2026-09-16 (item 309).
  it("comparison.md's plugin-pipeline bullet names every hook", async () => {
    const text = await Bun.file(path.join(DOCS, 'comparison.md')).text()
    const m = /\*\*The plugin pipeline \(2026-09-02\)\.\*\*([\s\S]*?)Core applies/.exec(text)
    expect(m).not.toBeNull()
    const named = new Set([...m![1]!.matchAll(/`([a-z]+)`/g)].map((x) => x[1]!))
    for (const hook of PLUGIN_HOOKS) expect(named).toContain(hook)
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
