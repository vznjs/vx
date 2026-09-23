// Refusals in `workspace/config-schema.ts` that the 628-method sweep (item
// 653) found unheld: each row names the arm it holds, and each went red with
// that arm deleted alone. Messages are compared whole (`toBe`) — a substring
// probe would be satisfied by a neighbouring refusal's text.
import { describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '../src/config.js'
import { validateWorkspace } from '../src/workspace/config-schema.js'
import { testPlugin } from './helpers/plugin.js'

const WS = '/ws/vx.workspace.ts'

function refusal(config: unknown): string | null {
  try {
    validateWorkspace(config as WorkspaceConfig, WS)
    return null
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return (err as Error).message
  }
}

describe('workspace refusals the sweep found unheld (item 653)', () => {
  it('a fractional concurrency is refused — the integer arm, past the positivity one', () => {
    expect(refusal({ concurrency: 1.5 })).toBe(`${WS}: \`concurrency\` must be a positive integer`)
    // Control: an integer passes, so the row is not held by a coarser gate.
    expect(refusal({ concurrency: 2 })).toBeNull()
  })

  it('an EMPTY package stamp is refused like a missing one', () => {
    // `definePlugin` never stamps '' (a nameless package.json is refused
    // there), but the stamp is a registry symbol another copy of vx writes,
    // and this schema is the one boundary every plugin crosses.
    const forged = { name: '', [Symbol.for('vx.plugin.package')]: '', teardown() {} }
    expect(refusal({ plugins: [forged] })).toBe(
      `${WS}: \`plugins[0]\` must come from definePlugin(import.meta, { … }) — a plugin's name is its package name`,
    )
    // Control: the same object stamped with a real name validates.
    const stamped = { name: 'p', [Symbol.for('vx.plugin.package')]: 'p', teardown() {} }
    expect(refusal({ plugins: [stamped] })).toBeNull()
  })

  it('a non-object `commands` is refused, not read as a plugin that contributes a verb', () => {
    // `Object.entries(7)` is `[]`: without the shape check the plugin passes
    // the at-least-one-capability rule on a `commands` that declares nothing.
    const p = { ...testPlugin('sweep-653-cmd', { teardown() {} }), commands: 7 }
    expect(refusal({ plugins: [p] })).toBe(`${WS}: \`plugins[0].commands\` must be an object`)
  })

  it('a fingerprint claim over NO files is refused', () => {
    const claim = { files: [], affected: () => new Set<string>() }
    const p = testPlugin('sweep-653-fp', { fingerprint: claim as never })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].fingerprint\` must be { files: [name, …], affected: function }`,
    )
    // Control: the same claim over a file core folds validates.
    const ok = testPlugin('sweep-653-fp-ok', {
      fingerprint: { files: ['bun.lock'], affected: () => new Set<string>() } as never,
    })
    expect(refusal({ plugins: [ok] })).toBeNull()
  })
})
