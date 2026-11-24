// A lockfile the plugin cannot read refuses the run with its file named
// ONCE and the install that fixes it. The plugin prefixes the file to a
// parser's message unless the message already opens with `<file>:`, so a
// parser that names its file any other way says it twice: pnpm's
// "pnpm-lock.yaml: pnpm-lock.yaml is not a YAML document" (item 904),
// after bun's "bun.lock: bun.lock: Failed to parse JSONC" (2026-09-20).
// One row per manager, each through the parser's own message.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { bun, npm, pnpm, yarn } from '../src/index.js'
import { affectedRefusal, commitAll } from './helpers/affected.js'
import { lockedKey } from './helpers/key.js'

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
      'yarn.lock: holds git merge conflict markers — regenerate it with `yarn install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'pnpm-lock.yaml: holds git merge conflict markers — regenerate it with `pnpm install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'package-lock.json: holds git merge conflict markers — regenerate it with `npm install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'bun.lock: holds git merge conflict markers — regenerate it with `bun install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
    ])
  })

  it('is named once, by each parser’s own message, with the install that fixes it', () => {
    expect([
      refusal(pnpm(), 'pnpm-lock.yaml', '- a\n'),
      refusal(npm(), 'package-lock.json', '{}'),
      refusal(yarn(), 'yarn.lock', 'hello: world\n'),
      refusal(bun(), 'bun.lock', '{}'),
    ]).toEqual([
      'pnpm-lock.yaml: not a YAML document — regenerate it with `pnpm install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'package-lock.json: not an npm lockfile (no lockfileVersion) — regenerate it with `npm install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'yarn.lock: neither a classic (`# yarn lockfile v1`) nor a berry (`__metadata`) lockfile — regenerate it with `yarn install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'bun.lock: not a Bun text lockfile (no lockfileVersion) — regenerate it with `bun install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
    ])
  })
  // npm's parser named package-lock.json in every message, so a broken
  // shrinkwrap said "npm-shrinkwrap.json: package-lock.json: …".
  it('a shrinkwrap is named as itself, not as package-lock.json', () => {
    expect([
      refusal(npm(), 'npm-shrinkwrap.json', '{}'),
      refusal(npm(), 'npm-shrinkwrap.json', '{"lockfileVersion":1}'),
      refusal(npm(), 'npm-shrinkwrap.json', '{'),
    ]).toEqual([
      'npm-shrinkwrap.json: not an npm lockfile (no lockfileVersion) — regenerate it with `npm install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      'npm-shrinkwrap.json: lockfileVersion 1 has no `packages` map — npm 7+ writes version 2 or 3 — regenerate it with `npm install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      expect.stringMatching(/^npm-shrinkwrap\.json: (?!package-lock)/),
    ])
  })
})

describe('a conflicted lockfile on the digest path', () => {
  // `vx lock`'s digest reads a lockfile's extra files before its digest and edges,
  // and that read parsed the file with no conflict check: under pnpm, npm
  // and bun the run refused with a bare parse error, and the check the
  // digest and edges make was never reached.
  it('names the conflict markers under every manager', async () => {
    const conflicted = (head: string) =>
      `${head}\n<<<<<<< HEAD\nleft-pad@^1.0.0:\n  version "1.3.0"\n=======\nleft-pad@^1.0.0:\n  version "1.2.0"\n>>>>>>> other\n`
    const got: string[] = []
    for (const [plugin, file, head] of [
      [yarn(), 'yarn.lock', '# yarn lockfile v1\n'],
      [pnpm(), 'pnpm-lock.yaml', "lockfileVersion: '9.0'"],
      [npm(), 'package-lock.json', '{'],
      [bun(), 'bun.lock', '{'],
    ] as const) {
      const root = await mkdtemp(path.join(tmpdir(), 'vx-conflict-'))
      try {
        await writeFile(path.join(root, file), conflicted(head))
        got.push(
          await lockedKey(plugin, root, path.join(root, '.c')).then(
            () => '(no refusal)',
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          ),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    expect(got).toEqual([
      'yarn.lock: holds git merge conflict markers — regenerate it with `yarn install`',
      'pnpm-lock.yaml: holds git merge conflict markers — regenerate it with `pnpm install`',
      'package-lock.json: holds git merge conflict markers — regenerate it with `npm install`',
      'bun.lock: holds git merge conflict markers — regenerate it with `bun install`',
    ])
  })
})

describe('a malformed bun.lock on the digest path (L-16)', () => {
  // Its patch files are read before the digest, and that read refused
  // outside the digest's wrapper: a bare "JSONC Parse error", no file or
  // fix named (fuzzed).
  it('is refused as the digest path refuses it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-l16-'))
    try {
      await writeFile(path.join(root, 'bun.lock'), '{ "lockfileVersion": 1, "workspaces": {')
      const got = await lockedKey(bun(), root, path.join(root, '.c')).then(
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

describe("a base ref's bun.lock under --affected", () => {
  // Core reads the claimed file's patch list on both sides before the
  // claimant compares them, and that read refused with no side named: a
  // base commit's broken bun.lock told the user to regenerate the working
  // tree's, which was fine.
  it('is refused as of the base ref when only the base is broken', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-base-lock-'))
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
      )
      await mkdir(path.join(root, 'packages/a'), { recursive: true })
      await writeFile(
        path.join(root, 'packages/a/package.json'),
        JSON.stringify({ name: 'a', version: '1.0.0' }),
      )
      await writeFile(
        path.join(root, 'packages/a/vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        `import { bun } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\nexport default { plugins: [bun()] }\n`,
      )
      await writeFile(path.join(root, 'bun.lock'), '{garbage\n')
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      commitAll(root)
      await writeFile(
        path.join(root, 'bun.lock'),
        JSON.stringify({
          lockfileVersion: 1,
          workspaces: { '': { name: 'r' }, 'packages/a': { name: 'a', version: '1.0.0' } },
          packages: { a: ['a@workspace:packages/a'] },
        }),
      )
      const { exitCode, stderr } = affectedRefusal(root, 'build')
      expect(stderr).toContain('bun.lock: ')
      expect(stderr).toContain(
        ' — regenerate it with `bun install` (as of the base ref, which no install changes: name another base, `--affected=<ref>`)',
      )
      expect(exitCode).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('a pnpm-lock.yaml naming a package it has no entry for', () => {
  // pnpm refuses it (ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY, "Broken
  // lockfile"); the graph made the missing package a leaf, so a file cut
  // after `snapshots:` keyed every project on versions alone.
  const importerFoo =
    'importers:\n  .:\n    dependencies:\n      foo:\n        specifier: ^1.0.0\n        version: 1.0.0\n'
  const lockfiles: [string, string][] = [
    [
      `lockfileVersion: '9.0'\n${importerFoo}packages:\n  foo@1.0.0:\n    resolution: {integrity: sha512-x}\nsnapshots:\n`,
      'pnpm-lock.yaml: no entry for foo@1.0.0, which importer . names',
    ],
    [
      `lockfileVersion: '9.0'\n${importerFoo}packages:\n  foo@1.0.0:\n    resolution: {integrity: sha512-x}\nsnapshots:\n  foo@1.0.0:\n    dependencies:\n      bar: 2.0.0\n`,
      'pnpm-lock.yaml: no entry for bar@2.0.0, which foo@1.0.0 names',
    ],
    [
      `lockfileVersion: '6.0'\n${importerFoo}packages:\n  /foo@1.0.0:\n    resolution: {integrity: sha512-x}\n    dependencies:\n      bar: 2.0.0\n`,
      'pnpm-lock.yaml: no entry for /bar@2.0.0, which /foo@1.0.0 names',
    ],
    [
      'lockfileVersion: 5.4\nimporters:\n  .:\n    specifiers:\n      foo: ^1.0.0\n    dependencies:\n      foo: 1.0.0\npackages:\n',
      'pnpm-lock.yaml: no entry for /foo/1.0.0, which importer . names',
    ],
  ]
  for (const [text, message] of lockfiles) {
    it(`is refused: ${message}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-broken-'))
      try {
        await writeFile(path.join(root, 'pnpm-lock.yaml'), text)
        const got = await lockedKey(pnpm(), root, path.join(root, '.c')).then(
          () => '(no refusal)',
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        )
        expect(got).toBe(`${message} — regenerate it with \`pnpm install\``)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

describe('a pnpm-lock.yaml cut short', () => {
  // Cut after an entry's `dependencies:` header (or inside it), the last
  // snapshot read as one with no dependencies: the closure through it lost
  // every package below it, and the lock was written (probed, pnpm 10).
  const cut = (tail: string) => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      is-odd:
        specifier: 3.0.1
        version: 3.0.1

packages:

  is-number@6.0.0:
    resolution: {integrity: sha512-n}

  is-odd@3.0.1:
    resolution: {integrity: sha512-o}

snapshots:

  is-number@6.0.0: {}

  is-odd@3.0.1:${tail}`

  it('is refused, not read as an entry with no dependencies', () => {
    expect([
      refusal(pnpm(), 'pnpm-lock.yaml', cut('\n    dependencies:\n')),
      refusal(pnpm(), 'pnpm-lock.yaml', cut('\n    depe')),
      refusal(pnpm(), 'pnpm-lock.yaml', cut('\n    dependencies:\n      is-number: 6.0.0\n')),
    ]).toEqual([
      expect.stringMatching(/^pnpm-lock\.yaml: snapshots entry is-odd@3\.0\.1 .* regenerate it/),
      expect.stringMatching(/^pnpm-lock\.yaml: snapshots entry is-odd@3\.0\.1 .* regenerate it/),
      '(no refusal)',
    ])
  })
})

describe('a berry yarn.lock cut short', () => {
  // Cut after the last entry's `dependencies:` header, it read as an entry
  // with no dependencies: the closure through it lost them in silence.
  const cut = (tail: string) => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:.":
  version: 0.0.0-use.local
  resolution: "a@workspace:."
  dependencies:
    foo: "npm:^1"
  languageName: unknown
  linkType: soft

"bar@npm:^2":
  version: 2.0.0
  resolution: "bar@npm:2.0.0"
  checksum: 10c0/bar
  languageName: node
  linkType: hard

"foo@npm:^1":
  version: 1.0.0
  resolution: "foo@npm:1.0.0"${tail}`

  it('is refused, not read as an entry with no dependencies', () => {
    expect([
      refusal(yarn(), 'yarn.lock', cut('\n  dependencies:\n')),
      refusal(yarn(), 'yarn.lock', cut('\n  dependencies:\n    bar: "npm:^2"\n')),
      // Read past (vercel/turborepo#12828), it was a workspace with no dependencies.
      refusal(yarn(), 'yarn.lock', '__metadata:\n  version: 8\n\n"a@workspace:packages/a": 3\n'),
    ]).toEqual([
      expect.stringMatching(/^yarn\.lock: entry "foo@npm:\^1" .* regenerate it/),
      '(no refusal)',
      expect.stringMatching(/^yarn\.lock: entry "a@workspace:packages\/a" is not a mapping/),
    ])
  })
})
