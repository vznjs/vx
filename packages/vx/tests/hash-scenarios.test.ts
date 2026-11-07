// The hashing and input scenarios Nx and Turbo test that vx passed with no
// test of its own (Growth's hash-tests map, org/growth/parity/hash-tests,
// rows T6-T27). Each is a key read twice: a change the scenario says is
// an input must move it, one it says is not must leave it. Line endings,
// ignore rules and the walk; env, selection and names are in
// hash-scenarios-names.test.ts.

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { at, key, made, workspace } from './helpers/hash-scenarios.js'
import { PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'
import { gitIn } from './helpers/workspace.js'

afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('line endings (Turbo crlf)', () => {
  for (const attr of ['* text=auto\n', '* text\n', '*.txt text eol=crlf\n']) {
    it(
      `${attr.trim()}: a touch keeps the key, a same-size edit moves it, restoring the bytes brings it back`,
      async () => {
        const root = await workspace(
          "{ files: ['a.txt'] }",
          { 'a.txt': 'one\r\ntwo\r\n' },
          {
            '.gitattributes': attr,
          },
        )
        const clean = await key(root)
        const later = new Date(Date.now() + 5_000)
        await utimes(at(root, 'a.txt'), later, later)
        expect(await key(root)).toBe(clean)
        await writeFile(at(root, 'a.txt'), 'onE\r\ntwo\r\n')
        expect(await key(root)).not.toBe(clean)
        await writeFile(at(root, 'a.txt'), 'one\r\ntwo\r\n')
        expect(await key(root)).toBe(clean)
      },
      TIMEOUT,
    )
  }

  it(
    "a project's own .gitattributes applies: a same-size edit to a `text` file moves the key",
    async () => {
      const root = await workspace("{ files: ['a.md'] }", {
        '.gitattributes': '*.md text\n',
        'a.md': 'one\r\ntwo\r\n',
      })
      const clean = await key(root)
      await writeFile(at(root, 'a.md'), 'onE\r\ntwo\r\n')
      expect(await key(root)).not.toBe(clean)
    },
    TIMEOUT,
  )
})

/**
 * Back-date `rels` and refresh the index, so git records their stat with no
 * racy smudge: a file written in the second of its commit is hashed from
 * disk whatever git says, which would hide a wrong clean verdict.
 */
async function settle(root: string, rels: readonly string[]): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  for (const rel of rels) await utimes(at(root, rel), past, past)
  gitIn(root)('update-index', '--really-refresh')
}

// Turbo d154e7e92 (vercel/turborepo#14697) matched git's text=auto binary
// check: a file git stores raw keeps its CRs. vx hashes a filtered file's
// raw bytes, so a LF→CRLF rewrite moves the key whatever git thinks of it.
describe('text=auto, git binary detection (vercel/turborepo#14697)', () => {
  it.each([
    ['a lone CR', 'a\nb\rc\n'],
    ['a NUL past the first 8000 bytes', `${'a\n'.repeat(4500)}\0\n`],
    ['a control byte', 'a\u0001\nb\n'],
    ['plain text', 'a\nb\n'],
  ])(
    '%s: an LF→CRLF rewrite moves the key',
    async (_, body) => {
      const root = await workspace(
        "{ files: ['data.bin'] }",
        { 'data.bin': body },
        {
          '.gitattributes': '* text=auto\n',
        },
      )
      await settle(root, ['data.bin'])
      const clean = await key(root)
      await writeFile(at(root, 'data.bin'), body.replaceAll('\n', '\r\n'))
      expect(await key(root)).not.toBe(clean)
      // CONTROL: the bytes back, the key back.
      await writeFile(at(root, 'data.bin'), body)
      expect(await key(root)).toBe(clean)
    },
    TIMEOUT,
  )
})

// Turbo ebc204865 (vercel/turborepo#10844): without `-z` git C-quotes a
// non-ASCII path, which then names no file.
describe('a non-ASCII tracked input (vercel/turborepo#10844)', () => {
  it(
    'an uncommitted edit to it moves the key; the bytes back bring it back',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", { 'src/테스트.ts': 'one\n' })
      await settle(root, ['src/테스트.ts'])
      const clean = await key(root)
      await writeFile(at(root, 'src/테스트.ts'), 'two\n')
      expect(await key(root)).not.toBe(clean)
      await writeFile(at(root, 'src/테스트.ts'), 'one\n')
      expect(await key(root)).toBe(clean)
    },
    TIMEOUT,
  )
})

describe('ignore rules (Turbo scm, Nx walker)', () => {
  it(
    'an uncommitted .gitignore edit that un-ignores a file makes it an input, and one that re-ignores it takes it out',
    async () => {
      const root = await workspace(
        "{ files: ['src/**'] }",
        { 'src/a.txt': 'a\n' },
        { '.gitignore': '.vx/cache/\npackages/lib/src/gen.txt\n' },
      )
      await writeFile(at(root, 'src/gen.txt'), 'g\n')
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      const open = await key(root)
      await writeFile(at(root, 'src/gen.txt'), 'g2\n')
      expect(await key(root)).not.toBe(open)
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\npackages/lib/src/gen.txt\n')
      const closed = await key(root)
      await writeFile(at(root, 'src/gen.txt'), 'g3\n')
      expect(await key(root)).toBe(closed)
    },
    TIMEOUT,
  )

  it(
    'a self-ignoring `*` .gitignore keeps what it whitelists and nothing else',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", {
        'src/a.txt': 'a\n',
        'src/cache/.gitignore': '*\n!keep.txt\n!.gitignore\n',
      })
      await writeFile(at(root, 'src/cache/keep.txt'), 'k\n')
      await writeFile(at(root, 'src/cache/junk.txt'), 'j\n')
      const k0 = await key(root)
      await writeFile(at(root, 'src/cache/junk.txt'), 'j2\n')
      expect(await key(root)).toBe(k0)
      await writeFile(at(root, 'src/cache/keep.txt'), 'k2\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'only a file named .gitignore holds rules: foo.gitignore and .ignore do not',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", {
        'src/a.txt': 'a\n',
        'src/foo.gitignore': '*\n',
        'src/.ignore': 'b.txt\n',
        '.ignore': '*\n',
      })
      await writeFile(at(root, 'src/b.txt'), 'b\n')
      const k0 = await key(root)
      await writeFile(at(root, 'src/b.txt'), 'b2\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'a .gitignore above the git root does not apply',
    async () => {
      const outer = await mkdtemp(path.join(os.tmpdir(), 'vx-hash-scen-outer-'))
      made.push(outer)
      await writeFile(path.join(outer, '.gitignore'), '*.txt\n')
      const root = await workspace(
        "{ files: ['src/**'] }",
        { 'src/a.txt': 'a\n' },
        {},
        { dir: outer },
      )
      const k0 = await key(root)
      await writeFile(at(root, 'src/b.txt'), 'b\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )
})

describe('the walk (Turbo globwalk, Nx walker)', () => {
  it.skipIf(process.platform === 'win32')(
    // A socket too, in Turbo's test; the shard's sandbox refuses the bind.
    'a FIFO under an input glob neither hangs the key nor moves it',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", { 'src/a.txt': 'a\n' })
      const k0 = await key(root)
      expect(Bun.spawnSync(['mkfifo', at(root, 'src/fifo')]).exitCode).toBe(0)
      expect(await key(root)).toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'files created and deleted while the key is read never fail it',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", { 'src/a.txt': 'a\n' })
      let stop = false
      const churn = (async () => {
        for (let i = 0; !stop; i++) {
          for (let k = 0; k < 50; k++) {
            const p = at(root, `src/v${k}.txt`)
            await writeFile(p, String(i)).catch(() => undefined)
            await rm(p, { force: true })
          }
        }
      })()
      try {
        for (let i = 0; i < 8; i++) expect(await key(root)).toMatch(/^[0-9a-f]+$/)
      } finally {
        stop = true
        await churn
      }
    },
    TIMEOUT,
  )
})
