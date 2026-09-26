// A lockfile the plugin cannot read refuses the run with its file named
// ONCE and the install that fixes it. The plugin prefixes the file to a
// parser's message unless the message already opens with `<file>:`, so a
// parser that names its file any other way says it twice: pnpm's
// "pnpm-lock.yaml: pnpm-lock.yaml is not a YAML document" (item 904),
// after bun's "bun.lock: bun.lock: Failed to parse JSONC" (2026-09-20).
// One row per manager, each through the parser's own message.
import { describe, expect, it } from 'bun:test'
import { bun, npm, pnpm, yarn } from '../src/index.js'

type Affected = { fingerprint: { affected: (change: unknown, ctx: unknown) => unknown } }

function refusal(plugin: unknown, file: string, text: string): string {
  const bytes = new TextEncoder().encode(text)
  try {
    ;(plugin as Affected).fingerprint.affected(
      { file, before: bytes, after: bytes },
      { workspaceRoot: '/w', cacheDir: '/c', warn() {}, projects: [] },
    )
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return '(no refusal)'
}

describe('a lockfile the plugin cannot read', () => {
  it('is named once, by each parser’s own message, with the install that fixes it', () => {
    expect([
      refusal(pnpm(), 'pnpm-lock.yaml', '- a\n'),
      refusal(npm(), 'package-lock.json', '{}'),
      refusal(yarn(), 'yarn.lock', 'hello: world\n'),
      refusal(bun(), 'bun.lock', '{}'),
    ]).toEqual([
      'pnpm-lock.yaml: not a YAML document — regenerate it with `pnpm install` (as of the base ref)',
      'package-lock.json: not an npm lockfile (no lockfileVersion) — regenerate it with `npm install` (as of the base ref)',
      'yarn.lock: neither a classic (`# yarn lockfile v1`) nor a berry (`__metadata`) lockfile — regenerate it with `yarn install` (as of the base ref)',
      'bun.lock: not a Bun text lockfile (no lockfileVersion) — regenerate it with `bun install` (as of the base ref)',
    ])
  })
})
