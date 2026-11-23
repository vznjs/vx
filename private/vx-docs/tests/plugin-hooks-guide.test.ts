// The site's plugin guide tabulates the hooks by
// hand; they are held to core's one list here, so a stage added to
// `PLUGIN_HOOKS` cannot be missing from the guide a plugin author reads
// (the `admit` stage was, for a day, 2026-09-12).
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_HOOKS } from '@vzn/vx'

const GUIDES = path.resolve(import.meta.dir, '..', 'src', 'content', 'docs', 'docs')
const LIFECYCLE = new Set(['setup', 'teardown'])

describe('the site guides follow PLUGIN_HOOKS', () => {
  it('plugins.mdx declares every hook in its VxPlugin block', async () => {
    const text = await Bun.file(path.join(GUIDES, '..', 'docs', 'writing-plugins.mdx')).text()
    const block = /interface VxPlugin \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    const declared = new Set([...block.matchAll(/^\s+([a-z]+)\??[(:]/gm)].map((m) => m[1]!))
    for (const hook of PLUGIN_HOOKS) expect(declared).toContain(hook)
  })

  // The introduction's table lacked `admit` until 2026-09-16 (item 305). The
  // introduction and the extensibility page merged into the quickstart and
  // this guide (the site redo, R3); the stage table lives here now.
  for (const file of ['docs/writing-plugins.mdx']) {
    it(`${file} tabulates every stage (the lifecycle pair is prose)`, async () => {
      const text = await Bun.file(path.join(GUIDES, '..', file)).text()
      const found = new Set<string>()
      for (const line of text.split('\n')) {
        if (!line.startsWith('|')) continue
        for (const m of (line.split('|')[2] ?? '').matchAll(/`([a-z]+)(?:\(|`)/g)) found.add(m[1]!)
      }
      for (const hook of PLUGIN_HOOKS) if (!LIFECYCLE.has(hook)) expect(found).toContain(hook)
    })
  }
})

// The guide said a throw in `measures` or the `output` hook stopped the run;
// core warns and goes on for both (plugin-host.ts `measuresOf`,
// output-host.ts). Each hook core does not stop on is named in the list of
// what a throw costs, so "any other hook stops the run" stays true.
it('writing-plugins.mdx names every hook whose throw does not stop the run', async () => {
  const text = await Bun.file(path.join(GUIDES, 'writing-plugins.mdx')).text()
  const section = text.slice(text.indexOf('## What core refuses'), text.indexOf('## Next'))
  const before = section.slice(0, section.indexOf('A throw in any other hook stops the run'))
  for (const hook of ['telemetry', 'admit', 'output', 'measures', 'teardown'] as const) {
    expect(PLUGIN_HOOKS).toContain(hook)
    expect(before).toContain(`\`${hook}\``)
  }
})
