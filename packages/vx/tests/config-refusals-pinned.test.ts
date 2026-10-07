// The refusals a bad config meets are part of the config contract: a user
// greps for the message they got. Each one the validator, the loader or
// discovery can say (`throw new UserError(…)` in workspace/config-schema.ts,
// project-loader.ts and workspace.ts) is held word for word somewhere: a test, the schema contract records (which drive every
// field and rule), or docs/schema.md's error table (schema-doc-drift
// provokes each row). The law reads each refusal's static text and
// requires it in one of those; the rows below pin the five plugin-shape
// refusals nothing held whole.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '../src/config.js'
import { PLUGIN_HOOKS } from '../src/config.js'
import { validateWorkspace } from '../src/workspace/config-schema.js'
import { testPlugin } from './helpers/plugin.js'

const WS = '/ws/vx.workspace.ts'

function refusal(config: unknown): string | null {
  try {
    validateWorkspace(config as WorkspaceConfig, WS)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

describe('the plugin-shape refusals, whole', () => {
  it('a name set over the package name', () => {
    const p = testPlugin('pin-name', { teardown() {} })
    const pkg = p.name
    ;(p as { name: string }).name = 'other'
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].name\` overrides the package name ('other' over '${pkg}') — a plugin's name is its package name; drop the field`,
    )
  })

  it('the removed backend seam', () => {
    const p = Object.assign(testPlugin('pin-backend', { teardown() {} }), { backend: () => {} })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].backend\` is no longer a capability — the whole-run backend seam was removed in 2026-08. Use \`executor\` to change where a single task's command runs (see docs/architecture.md § plugin capabilities).`,
    )
  })

  it('a hook that is not a function', () => {
    const p = testPlugin('pin-hook', { teardown: 7 as never })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].teardown\` of plugin '${p.name}' must be a function`,
    )
  })

  it('a command without its description', () => {
    const p = testPlugin('pin-cmd', { commands: { hello: { run: () => 0 } } as never })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].commands.hello\` of plugin '${p.name}' must be { description: string, run: function }`,
    )
  })

  it('a plugin that contributes nothing', () => {
    const p = testPlugin('pin-empty', {})
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0]\` (plugin '${p.name}') must contribute at least one of ${PLUGIN_HOOKS.join('/')}`,
    )
  })
})

// The validator, the loader around it, and discovery: everything that
// refuses a workspace before a task runs.
const SOURCES = ['config-schema.ts', 'project-loader.ts', 'workspace.ts'].map((file) => ({
  file,
  text: readFileSync(path.join(import.meta.dir, '..', 'src', 'workspace', file), 'utf8'),
}))

/** Each `throw new UserError(…)`'s static text, as fragments of 14+ characters. */
function refusals(src: string): Array<{ line: number; fragments: string[] }> {
  const out: Array<{ line: number; fragments: string[] }> = []
  for (const m of src.matchAll(/throw new UserError\(/g)) {
    const call = src.slice(m.index + m[0].length).split(')\n')[0]!
    const pieces = [...call.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'/g)].map((p) =>
      (p[1] ?? p[2]!).replaceAll('\\`', '`').replaceAll("\\'", "'"),
    )
    const fragments = pieces
      .flatMap((p) => p.split(/\$\{[^}]*\}/))
      .map((f) => f.trim())
      .filter((f) => f.length >= 14)
    out.push({ line: src.slice(0, m.index).split('\n').length, fragments })
  }
  return out
}

function corpus(): string {
  const tests = readdirSync(import.meta.dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && f !== path.basename(import.meta.path))
    .map((f) => readFileSync(path.join(import.meta.dir, f), 'utf8'))
  const records = ['config-schema.json', 'config-schema-rules.json'].map((f) =>
    readFileSync(path.join(import.meta.dir, 'contract', f), 'utf8').replaceAll('\\"', '"'),
  )
  const doc = readFileSync(path.join(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
  const table = doc.slice(doc.indexOf('## Schema validation errors'))
  // This file's own pins count; its extraction code names no refusal.
  const own = readFileSync(import.meta.path, 'utf8')
  const text = [...tests, ...records, table, own].join('\n').replaceAll('\\`', '`')
  // A pin written across concatenated literals, or as a regex, holds the
  // words too: read each with the joins and the escapes taken out.
  const joined = text.replace(/['`]\s*\+\s*\n\s*['`]/g, '')
  return `${joined}\n${joined.replace(/\\([^\w\s])/g, '$1')}`
}

describe('every config and discovery refusal is held word for word', () => {
  const sites = SOURCES.flatMap(({ file, text }) => refusals(text).map((s) => ({ ...s, file })))

  it('reads each refusal and its static text', () => {
    expect(sites.length).toBeGreaterThan(80)
    const sample = refusals(
      "throw new UserError(\n  `${p}: \\`x\\` must be one long thing` +\n    'and more of it',\n)\n",
    )
    expect(sample[0]!.fragments).toEqual([': `x` must be one long thing', 'and more of it'])
  })

  it('holds each one with static text somewhere', () => {
    const held = corpus()
    const loose = sites
      .filter((s) => s.fragments.length > 0 && !s.fragments.some((f) => held.includes(f)))
      .map((s) => `${s.file}:${s.line} ${s.fragments[0]}`)
    expect(loose).toEqual([])
  })
})
