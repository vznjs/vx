// The out-of-project half of plugin-hooks-doc-drift.test.ts: CLAUDE.md
// lists the stages a plugin can fill and named 10 of 13 until 2026-09-16
// (item 292); it lives at the repository root, which a sandboxed shard
// cannot read.
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_HOOKS } from '../src/config.js'

describe('CLAUDE.md follows PLUGIN_HOOKS', () => {
  it('its "Pipeline stages a plugin can fill" sentence names every hook', async () => {
    const text = await Bun.file(path.resolve(import.meta.dir, '..', '..', '..', 'CLAUDE.md')).text()
    const m = /Pipeline stages a plugin can fill[\s\S]*?Design:/.exec(text)
    expect(m).not.toBeNull()
    const named = new Set([...m![0].matchAll(/`([a-z]+)`/g)].map((x) => x[1]!))
    for (const hook of PLUGIN_HOOKS) expect(named).toContain(hook)
  })
})
