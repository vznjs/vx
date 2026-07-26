// Stale-cache-hit regressions. Each case drives the REAL CLI against a real
// git-backed fixture, changes an input, runs again, and asserts vx did NOT
// replay the old artifact. That is what the user actually experiences, and it
// is the only shape that proves the bug: a unit test on the resolver can pass
// while the end-to-end key still collides.
//
// A stale hit is this tool's worst failure — vx reports a hit and hands back
// bytes built from inputs that have since changed. Every case here was
// reproduced against the pre-fix tree before the fix landed.

import { mkdir, mkdtemp, readFile, rm, writeFile, utimes, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { parseFlaggedOutput } from '../src/cache/inputs.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    const detail = [
      new TextDecoder().decode(p.stderr).trim(),
      new TextDecoder().decode(p.stdout).trim(),
    ]
      .filter((s) => s.length > 0)
      .join(' | ')
    throw new Error(`git ${args.join(' ')} exited ${p.exitCode}: ${detail}`)
  }
}

/** Run the real CLI and return its combined output. */
function vx(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-stale-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('stale cache hits', () => {
  it(
    'a content change that preserves mtime is not served from the file-hash memo',
    async () => {
      // The (mtime, size) memo in `file_hashes` spans runs, so any producer
      // that preserves mtime — `tar -x`, `unzip`, `cp -p`, `rsync --times`,
      // a SOURCE_DATE_EPOCH generator — could hand back the previous run's
      // digest for genuinely different bytes.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cp src/in.txt dist/out.txt' },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/in.txt'), 'AAA')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      // Left UNTRACKED on purpose: a tracked+clean file takes the git index
      // OID path instead, which never consults this memo.
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\n')

      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('AAA')

      // Same byte length, mtime forced back to what the first run recorded.
      const before = await stat(path.join(root, 'src/in.txt'))
      await write(path.join(root, 'src/in.txt'), 'BBB')
      await utimes(path.join(root, 'src/in.txt'), before.atime, before.mtime)

      const out = vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('BBB')
      expect(out).not.toMatch(/up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'a wiped output stops counting as a consumer input on the cache-miss path',
    async () => {
      // The producer's `cleanOutputs` wipes gen/ before every attempt. Those
      // paths are tracked and clean at run start, so they carry index OIDs —
      // and resolveFiles skips its existence probe for OID-carrying paths.
      // Unless the wipe is recorded, a file that is GONE FROM DISK stays in
      // the consumer's input set and its key never moves.
      //
      // `cache.inputs.tasks: []` decouples the consumer from the producer's
      // hash — a documented pattern (docs/schema.md), and what makes the
      // defect observable rather than masked by the upstream cascade.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             codegen: {
               exec: { command: 'sh emit.sh' },
               cache: { inputs: { files: ['emit.sh'] }, outputs: { files: ['gen/**'] } },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               cache: {
                 inputs: { files: ['gen/*.ts'], tasks: [] },
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(
        path.join(root, 'emit.sh'),
        'mkdir -p gen\nprintf a > gen/a.js\nprintf content-of-b > gen/b.ts\n',
      )
      await write(path.join(root, 'gen/a.js'), 'a')
      await write(path.join(root, 'gen/b.ts'), 'content-of-b')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

      // The producer stops emitting b.ts. The consumer's real input set is now
      // empty, so its output must become empty too.
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf a > gen/a.js\n')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')
    },
    TIMEOUT,
  )

  it(
    'materialising a skip-worktree input moves the key',
    async () => {
      // `skip-worktree` sits at stage 0 and `git status` reports nothing for
      // it, so it kept a trusted index OID — and resolveFiles skips its
      // existence probe for OID-carrying paths. A run executed while a
      // sparse-checkout path was absent would then be replayed once the path
      // was materialised, because no key ever moved.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt' },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/a.txt'), 'A')
      await write(path.join(root, 'src/sparse.txt'), 'SPARSE')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      // Emulate a sparse checkout: tell git to stop looking, then remove it.
      git(root, 'update-index', '--skip-worktree', 'src/sparse.txt')
      await rm(path.join(root, 'src/sparse.txt'))

      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('A')

      // Materialise it. The real input set changed, so the output must too.
      await write(path.join(root, 'src/sparse.txt'), 'SPARSE')
      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('ASPARSE')
    },
    TIMEOUT,
  )
})

describe('parseFlaggedOutput', () => {
  const rec = (...lines: string[]): string => lines.join('\0') + '\0'

  it('flags skip-worktree (S) and every assume-unchanged (lowercase) state', () => {
    // Uppercase S is skip-worktree; a lowercase letter is assume-unchanged
    // layered on whatever state that letter names. `H` (plain cached) is the
    // only common state that must NOT be flagged.
    expect([...parseFlaggedOutput(rec('H a.txt', 'S b.txt', 'h c.txt', 'r d.txt'))].sort()).toEqual(
      ['b.txt', 'c.txt', 'd.txt'],
    )
  })

  it('keeps paths verbatim, including spaces and non-ASCII', () => {
    expect([...parseFlaggedOutput(rec('S dir/a b.txt', 'S ünï.txt'))].sort()).toEqual([
      'dir/a b.txt',
      'ünï.txt',
    ])
  })

  it('ignores empty and malformed records', () => {
    expect([...parseFlaggedOutput('')]).toEqual([])
    expect([...parseFlaggedOutput(rec('S', 'Sx.txt', 'H a.txt'))]).toEqual([])
  })
})
