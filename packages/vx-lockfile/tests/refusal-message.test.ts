// A lockfile the plugin cannot read refuses the run with its file named
// ONCE and the install that fixes it. The plugin prefixes the file to a
// parser's message unless the message already opens with `<file>:`, so a
// parser that names its file any other way says it twice: pnpm's
// "pnpm-lock.yaml: pnpm-lock.yaml is not a YAML document" (item 904),
// after bun's "bun.lock: bun.lock: Failed to parse JSONC" (2026-09-20).
// One row per manager, each through the parser's own message.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  // Yarn classic's line parser took the second side of a conflict in
  // silence; the others refused only through a parse error.
  it('holding git merge conflict markers is refused by every manager', () => {
    const conflicted = (head: string) =>
      `${head}\n<<<<<<< HEAD\nleft-pad@^1.0.0:\n  version "1.3.0"\n=======\nleft-pad@^1.0.0:\n  version "1.2.0"\n>>>>>>> other\n`
    expect([
      refusal(yarn(), 'yarn.lock', conflicted('# yarn lockfile v1\n')),
      refusal(pnpm(), 'pnpm-lock.yaml', conflicted("lockfileVersion: '9.0'")),
      refusal(npm(), 'package-lock.json', conflicted('{')),
      refusal(bun(), 'bun.lock', conflicted('{')),
    ]).toEqual([
      'yarn.lock: holds git merge conflict markers — regenerate it with `yarn install` (as of the base ref)',
      'pnpm-lock.yaml: holds git merge conflict markers — regenerate it with `pnpm install` (as of the base ref)',
      'package-lock.json: holds git merge conflict markers — regenerate it with `npm install` (as of the base ref)',
      'bun.lock: holds git merge conflict markers — regenerate it with `bun install` (as of the base ref)',
    ])
  })

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

describe('a malformed bun.lock on the key path (L-16)', () => {
  // Its patch files are read before the digest, and that read refused
  // outside the digest's wrapper: a bare "JSONC Parse error", no file or
  // fix named (fuzzed).
  it('is refused as the digest path refuses it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-l16-'))
    try {
      await writeFile(path.join(root, 'bun.lock'), '{ "lockfileVersion": 1, "workspaces": {')
      const key = (bun() as unknown as { key: (t: unknown, c: unknown) => Promise<unknown> }).key
      const got = await key(
        { projectDir: root },
        { workspaceRoot: root, cacheDir: path.join(root, '.c') },
      ).then(
        () => '(no refusal)',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      expect(got.startsWith('bun.lock: ')).toBe(true)
      expect(got.endsWith(' — regenerate it with `bun install`')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
