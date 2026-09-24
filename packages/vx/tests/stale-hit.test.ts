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
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import {
  GitFilesCache,
  autocrlfConverts,
  parseCheckAttrOutput,
  populateGitFilesCache,
} from '../src/cache/inputs.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    // Identity and signing on the HELPER, not on each row: every case here
    // commits, and a runner with no global git identity refuses to
    // (`empty ident name`). Eighteen call sites set it by hand and two new
    // ones forgot, which only showed up on CI — this box has a global
    // identity and the runner does not.
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=test@vx.local',
      '-c',
      'user.name=vx test',
      ...args,
    ],
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
    'a corrupted WORKSPACE-anchored output is not "up-to-date" either',
    async () => {
      // The same short-circuit's fingerprint check is a conjunction over TWO
      // roots — the project dir and the workspace root. Only the project half
      // was pinned: dropping the workspace half left the whole repo green
      // while a root-anchored output that had been edited on disk stayed
      // edited, under a run that reported success.
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeLocalWorkspace(root)
      const pkg = path.join(root, 'packages', 'p')
      await write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
      await write(path.join(pkg, 'src', 'in.txt'), 's')
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { tasks: { gen: {
           exec: { command: 'mkdir -p ../../shared && printf g > ../../shared/g.txt' },
           cache: {
             inputs: { files: ['src/**'] },
             outputs: { files: [], workspaceFiles: ['shared/**'] },
           },
         } } }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')

      vx(root, 'run', 'gen', '--all')
      expect(await readFile(path.join(root, 'shared', 'g.txt'), 'utf8')).toBe('g')

      // Edit the root-anchored output in place: same path set, wrong bytes.
      await write(path.join(root, 'shared', 'g.txt'), 'CORRUPT')
      vx(root, 'run', 'gen', '--all')
      expect(await readFile(path.join(root, 'shared', 'g.txt'), 'utf8')).toBe('g')
    },
    TIMEOUT,
  )

  it(
    'a STRAY file in a declared output dir is not "up-to-date" — the set must match',
    async () => {
      // The "tree is already current" short-circuit requires BOTH that the
      // output-glob walk yields exactly the expected paths AND that every
      // file's fingerprint matches. The two halves catch DIFFERENT
      // divergences, and only one of them was pinned: a MISSING output is
      // caught by the fingerprint check, so dropping the set comparison left
      // the whole repo green — while a STRAY file survived a run that
      // reported `up-to-date`, leaving a tree that does not match the
      // artifact vx just claimed to have.
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }))
      await writeLocalWorkspace(root)
      await write(path.join(root, 'src', 'in.txt'), 's')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && printf a > dist/a.txt && printf b > dist/b.txt' },
           cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')

      vx(root, 'run', 'build')
      // A stray alongside the expected outputs: same fingerprints, wrong SET.
      await write(path.join(root, 'dist', 'STRAY.txt'), 'zzz')

      const out = vx(root, 'run', 'build')
      expect(out).toContain('restored-local')
      expect(out).not.toContain('up-to-date')
      expect(await Bun.file(path.join(root, 'dist', 'STRAY.txt')).exists()).toBe(false)
      expect(await readFile(path.join(root, 'dist', 'a.txt'), 'utf8')).toBe('a')
      expect(await readFile(path.join(root, 'dist', 'b.txt'), 'utf8')).toBe('b')
    },
    TIMEOUT,
  )

  it(
    'a content change that preserves mtime is not served from the file-hash memo',
    async () => {
      // The (mtime, size) memo in `file_hashes` spans runs, so any producer
      // that preserves mtime — `tar -x`, `unzip`, `cp -p`, `rsync --times`,
      // a SOURCE_DATE_EPOCH generator — could hand back the previous run's
      // digest for genuinely different bytes.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
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
      await writeLocalWorkspace(root)
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
    'a workspace output written mid-run reaches a consumer whose partition was read before it',
    async () => {
      // The ADDITION twin, on the miss path: `early` reads the workspace
      // partition first (codegen waits on it), codegen then writes gen/b.ts
      // at the root, and consume resolves `gen/*.ts` against a partition
      // enumerated before that write. Two lines in miss-save.ts keep it
      // honest — the root-anchored mark and the partition invalidation —
      // and they mask each other; with both gone, consume keys from an
      // EMPTY input set, and a later run whose real input set is empty
      // (emit.sh emits no .ts) hits run one's artifact and restores
      // content the inputs no longer hold.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               cache: { inputs: { files: [], workspaceFiles: ['gen/*.ts'] }, outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'sh emit.sh' },
               cache: {
                 inputs: { files: ['emit.sh'], tasks: [] },
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               cache: {
                 inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf content-of-b > gen/b.ts\n')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      vx(root, 'run', 'consume', '--concurrency', '1')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

      // The producer stops emitting any .ts: consume's real input set is
      // empty, so its output must be empty too — not run one's bytes.
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf a > gen/a.js\n')
      vx(root, 'run', 'consume', '--concurrency', '1')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')
    },
    TIMEOUT,
  )

  it(
    'a wiped output stops counting as a consumer input on the cache-HIT path too',
    async () => {
      // The hit's restore wipes gen/ before it writes the artifact's files,
      // and marks BOTH sets — the wiped paths and the restored ones. Only
      // the restored half had a witness. The snapshot must predate the
      // wipe for the mark to matter (`early` reads it; codegen waits on
      // early): a tracked-clean file the wipe removes and the artifact
      // does not bring back (old.ts here) then keeps its index OID, and
      // the consumer keys on a file that is gone and misses where it
      // should hit (item 638). Enumerated after the wipe, git status
      // reports the deletion itself and the mark is moot; and a restored
      // file the consumer's globs match re-enumerates on its own, so the
      // artifact here holds only a .js.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               cache: { inputs: { files: ['gen/*.ts'] }, outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'sh emit.sh' },
               cache: { inputs: { files: ['emit.sh'], tasks: [] }, outputs: { files: ['gen/**'] } },
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
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf b > gen/b.js\n')
      await write(path.join(root, 'gen/b.js'), 'b')
      await write(path.join(root, 'gen/old.ts'), 'content-of-old')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      // Cold: codegen wipes old.ts and emits b.js; consume's set is empty.
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')

      // old.ts is back from the index, tracked and clean; codegen's key is
      // unchanged, so it HITS, and its restore wipes old.ts again. The
      // restored b.js matches none of consume's globs, so only the WIPED
      // path can send consume back to git for a fresh listing.
      git(root, 'checkout', '--', 'gen/old.ts')
      const out = vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')
      // consume's real input set is empty, as in the cold run: a hit.
      expect(out).toMatch(/consume[^\n]*up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'the ROOT-ANCHORED twin of that hit-path wipe is recorded too',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               cache: { inputs: { files: [], workspaceFiles: ['gen/*.ts'] }, outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'sh emit.sh' },
               cache: {
                 inputs: { files: ['emit.sh'], tasks: [] },
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               cache: {
                 inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf b > gen/b.js\n')
      await write(path.join(root, 'gen/b.js'), 'b')
      await write(path.join(root, 'gen/old.ts'), 'content-of-old')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')

      git(root, 'checkout', '--', 'gen/old.ts')
      const out = vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')
      expect(out).toMatch(/consume[^\n]*up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'the ROOT-ANCHORED twin of that wipe is recorded too',
    async () => {
      // `cache.outputs.workspaceFiles` is wiped by `cleanWorkspaceOutputs`
      // and recorded by `markWorkspaceOutputsChanged` — the exact twin of the
      // per-project pair above, and the one that can delete files in ANOTHER
      // project's directory. Only the per-project copy had a witness: remove
      // the workspace mark, or the workspace wipe outright, and nothing in
      // the suite moved. Same defect, same mechanism (a tracked-clean path
      // keeps its index OID, so resolveFiles skips the existence probe and a
      // deleted file stays in the consumer's input set).
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             codegen: {
               exec: { command: 'sh emit.sh' },
               cache: {
                 inputs: { files: ['emit.sh'] },
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               cache: {
                 inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
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
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

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
      await writeLocalWorkspace(root)
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

  it(
    'editing an assume-unchanged input moves the key',
    async () => {
      // The sibling of the skip-worktree row above, and the half nothing
      // held. `--assume-unchanged` is the OTHER way to tell git to stop
      // looking at a worktree file — people use it on a tracked config
      // they edit locally and never commit — and `git ls-files -v` marks
      // it with a LOWERCASE letter (`h`) where skip-worktree is `S`.
      // Both are silent in `git status --porcelain`, so both keep a
      // trusted index OID that no longer describes the disk. Dropping
      // only the lowercase half of that guard passes the entire repo.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
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
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      git(root, 'update-index', '--assume-unchanged', 'src/a.txt')
      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('A')

      // git still reports nothing — that is the whole point of the flag —
      // so the only thing that can move the key is vx distrusting the OID.
      await write(path.join(root, 'src/a.txt'), 'B')
      const status = Bun.spawnSync({ cmd: ['git', 'status', '--porcelain'], cwd: root })
      expect(status.stdout.toString().trim()).toBe('')
      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('B')
    },
    TIMEOUT,
  )

  it(
    'a text filter declared at the workspace root reaches a SCOPED run too',
    async () => {
      // The gate that decides whether to ask `git check-attr` used to read
      // only the files the enumeration listed — and a scoped run lists the
      // project dirs alone, so the workspace root's own `.gitattributes`
      // (where a monorepo puts it) was invisible and every filtered OID
      // stayed trusted. Measured on this fixture before the fix: `--all`
      // was a miss and `--filter app` reported up-to-date and replayed the
      // CRLF byte count. Both arms run here, because the pair IS the
      // evidence — the unscoped one was correct all along and is the
      // control that keeps this row from passing for the wrong reason.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeLocalWorkspace(root)
      const proj = path.join(root, 'packages', 'app')
      await write(path.join(proj, 'package.json'), '{"name":"app","version":"1.0.0"}')
      await write(
        path.join(proj, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && wc -c < src/a.txt > dist/out.txt' },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitattributes'), '* text=auto\n')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\n')
      await write(path.join(proj, 'src/a.txt'), 'one\r\ntwo\r\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      // `git add` normalized the index to LF; checkout does not convert back
      // on Linux. Worktree CRLF, index LF, status clean — the defect's state.
      await write(path.join(proj, 'src/a.txt'), 'one\r\ntwo\r\n')

      const out = path.join(proj, 'dist/out.txt')
      vx(root, 'run', 'build', '--filter', 'app')
      expect((await readFile(out, 'utf8')).trim()).toBe('10')
      await write(path.join(proj, 'src/a.txt'), 'one\ntwo\n')
      vx(root, 'run', 'build', '--filter', 'app')
      expect((await readFile(out, 'utf8')).trim()).toBe('8')

      // CONTROL: the unscoped arm, whose pathspec is `.` so the root file
      // was always listed. It passed before the fix and must still pass.
      await write(path.join(proj, 'src/a.txt'), 'one\r\ntwo\r\n')
      vx(root, 'run', 'build', '--all')
      expect((await readFile(out, 'utf8')).trim()).toBe('10')
      await write(path.join(proj, 'src/a.txt'), 'one\ntwo\n')
      vx(root, 'run', 'build', '--all')
      expect((await readFile(out, 'utf8')).trim()).toBe('8')
    },
    TIMEOUT,
  )

  it(
    'a CRLF-to-LF change under a text filter is not served from cache',
    async () => {
      // A trusted index OID is the FILTERED blob, not the worktree bytes the
      // task reads. Under `text=auto` git stores the LF form, so `git status`
      // (which compares after filtering) calls a CRLF worktree file clean and
      // it keeps its OID — the CRLF and LF states then fold the SAME key.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && wc -c < src/a.txt > dist/out.txt' },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitattributes'), '* text=auto\n')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\n')
      await write(path.join(root, 'src/a.txt'), 'one\r\ntwo\r\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      // Restore CRLF: `git add` normalized the index to LF, and checkout does
      // not convert back on Linux. This is the state the defect lives in —
      // worktree CRLF, index LF, status clean.
      await write(path.join(root, 'src/a.txt'), 'one\r\ntwo\r\n')

      vx(root, 'run', 'build')
      expect((await readFile(path.join(root, 'dist/out.txt'), 'utf8')).trim()).toBe('10')

      await write(path.join(root, 'src/a.txt'), 'one\ntwo\n')
      vx(root, 'run', 'build')
      expect((await readFile(path.join(root, 'dist/out.txt'), 'utf8')).trim()).toBe('8')
    },
    TIMEOUT,
  )

  it(
    'core.autocrlf alone is enough to distrust index OIDs',
    async () => {
      // The same divergence with NO .gitattributes at all: `core.autocrlf`
      // converts every auto-detected text file, so no attribute names it and
      // an attributes-only gate would miss this entirely.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && wc -c < src/a.txt > dist/out.txt' },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\n')
      await write(path.join(root, 'src/a.txt'), 'one\r\ntwo\r\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'config', 'core.autocrlf', 'true')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      await write(path.join(root, 'src/a.txt'), 'one\r\ntwo\r\n')

      vx(root, 'run', 'build')
      expect((await readFile(path.join(root, 'dist/out.txt'), 'utf8')).trim()).toBe('10')

      await write(path.join(root, 'src/a.txt'), 'one\ntwo\n')
      vx(root, 'run', 'build')
      expect((await readFile(path.join(root, 'dist/out.txt'), 'utf8')).trim()).toBe('8')
    },
    TIMEOUT,
  )

  it(
    'a repo with no attributes and no autocrlf never runs check-attr',
    async () => {
      // The whole point of the gate: the common case must pay NOTHING. If this
      // ever spawns check-attr, every warm run in every plain repo just got a
      // serial git round-trip it does not need.
      await write(path.join(root, 'pkg/src/a.ts'), 'export const a = 1')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      const origSpawn = Bun.spawn
      const seen: string[][] = []
      const bunMut = Bun as unknown as { spawn: typeof Bun.spawn }
      bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
        const opt = a[0] as { cmd?: readonly string[] } | undefined
        // Spawned by its absolute path (util/which.ts).
        if (opt && Array.isArray(opt.cmd) && path.basename(opt.cmd[0] ?? '') === 'git')
          seen.push([...opt.cmd])
        return origSpawn(...a)
      }) as typeof Bun.spawn
      try {
        const cache = new GitFilesCache()
        await populateGitFilesCache(root, [path.join(root, 'pkg')], cache)
      } finally {
        bunMut.spawn = origSpawn
      }
      expect(seen.some((cmd) => cmd.includes('check-attr'))).toBe(false)
      // The gate probe itself must stay in the concurrent batch, not serial.
      expect(seen.some((cmd) => cmd.includes('--get-regexp'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a workspace-anchored OUTPUT landing in the consumer project is not classified stable',
    async () => {
      // `cache.outputs.workspaceFiles` is root-anchored and deliberately
      // boundary-IGNORING — it may write inside ANOTHER project's dir. So a
      // consumer in that project, reading the same path with an ordinary
      // PROJECT-RELATIVE `cache.inputs.files`, has a preliminary key until the
      // producer runs.
      //
      // The stability gate missed exactly this pairing: `upstreamOutputProjects`
      // holds the PRODUCER's project (`gen`), never the consumer's (`app`), and
      // the workspace-reader clause does not fire because the consumer reads
      // project-relative. Classified stable, its key was derived UP FRONT from
      // the previous generation's bytes and reused verbatim by execute-task —
      // and the `anyWorkspaceOutputs` mitigation only disables the restore
      // tier, not probe reuse, which is the half that serves the stale bytes.
      await write(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
      )
      await writeLocalWorkspace(root)
      await write(path.join(root, 'pkgs/gen/package.json'), JSON.stringify({ name: 'gen' }))
      await write(
        path.join(root, 'pkgs/app/package.json'),
        JSON.stringify({ name: 'app', dependencies: { gen: '*' } }),
      )
      await write(
        path.join(root, 'pkgs/gen/vx.config.mjs'),
        [
          'export default { tasks: { codegen: {',
          '  exec: { command: "mkdir -p ../app/gen out && cat src/version.txt > ../app/gen/out.txt && cp src/version.txt out/marker.txt" },',
          '  cache: {',
          '    inputs: { files: ["src/**"] },',
          '    outputs: { files: ["out/**"], workspaceFiles: ["pkgs/app/gen/**"] },',
          '  },',
          '} } }',
          '',
        ].join('\n'),
      )
      await write(
        path.join(root, 'pkgs/app/vx.config.mjs'),
        [
          'export default { tasks: { build: {',
          '  dependsOn: ["gen#codegen"],',
          '  exec: { command: "cat gen/out.txt" },',
          // `tasks: []` decouples the upstream key fold — the documented
          // content-invalidation pattern. Without it the upstream's own input
          // key cascades into this key and masks the defect, which is exactly
          // how the 2026-07-19 stale hit had to be reproduced too.
          '  cache: { inputs: { files: ["gen/**"], tasks: [] }, outputs: { files: ["dist/**"] } },',
          '} } }',
          '',
        ].join('\n'),
      )
      // Seeded with a value no cycle uses, so every cycle's commit is real.
      await write(path.join(root, 'pkgs/gen/src/version.txt'), 'v0')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 't@vx.local')
      git(root, 'config', 'user.name', 'vx')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'initial')

      // Assert the invariant at EVERY cycle rather than at a fixed index. The
      // collision's position drifts between runs (observed at cycle 5, 6 and 9
      // across otherwise identical sequences), so a test that checks one
      // nominated cycle passes intermittently on the unfixed tree — measured
      // 1 failure in 5. The invariant itself never drifts: whatever the task
      // reports must equal what the producer actually left on disk.
      const cycle = async (version: string): Promise<void> => {
        await write(path.join(root, 'pkgs/gen/src/version.txt'), version)
        git(root, 'add', '-A')
        git(root, 'commit', '-qm', version)
        const out = vx(root, 'run', 'build', '--all', '--output-logs', 'full')
        const reported = out
          .split('\n')
          .map((l) => l.trim())
          .find((l) => /^v[ABC]$/.test(l))
        const disk = await readFile(path.join(root, 'pkgs/app/gen/out.txt'), 'utf8')
        expect({ version, reported }).toEqual({ version, reported: disk })
      }

      // Three distinct generations, cycled. The producer rewrites the
      // consumer's input every run, so the consumer must never replay an
      // older generation's output.
      for (const v of ['vA', 'vB', 'vC', 'vA', 'vB', 'vC', 'vA', 'vB', 'vC']) {
        await cycle(v)
      }
    },
    TIMEOUT,
  )
})

describe('parseCheckAttrOutput', () => {
  const triples = (...t: string[][]): string => t.flat().join('\0') + '\0'

  it('drops only paths where a conversion-capable attribute is set', () => {
    expect(
      [
        ...parseCheckAttrOutput(
          triples(
            ['a.ts', 'text', 'auto'],
            ['a.ts', 'eol', 'unspecified'],
            ['a.ts', 'ident', 'unspecified'],
            ['b.png', 'text', 'unset'],
            ['b.png', 'eol', 'unspecified'],
            ['b.png', 'ident', 'unspecified'],
            ['c.sh', 'text', 'unspecified'],
            ['c.sh', 'eol', 'lf'],
            ['c.sh', 'ident', 'unspecified'],
            ['d.c', 'text', 'unspecified'],
            ['d.c', 'eol', 'unspecified'],
            ['d.c', 'ident', 'set'],
          ),
        ),
      ].sort(),
    ).toEqual(['a.ts', 'c.sh', 'd.c'])
  })

  it('keeps everything when nothing is specified, and tolerates empty input', () => {
    expect([
      ...parseCheckAttrOutput(
        triples(
          ['x', 'text', 'unspecified'],
          ['x', 'eol', 'unspecified'],
          ['x', 'ident', 'unspecified'],
        ),
      ),
    ]).toEqual([])
    expect([...parseCheckAttrOutput('')]).toEqual([])
  })
})

describe('autocrlfConverts', () => {
  it('is true only for the values that actually convert', () => {
    expect(autocrlfConverts('core.autocrlf true')).toBe(true)
    expect(autocrlfConverts('core.autocrlf input')).toBe(true)
    expect(autocrlfConverts('core.autocrlf false')).toBe(false)
    expect(autocrlfConverts('')).toBe(false)
    // Other core.* keys in the same output must not be mistaken for it.
    expect(autocrlfConverts('core.eol lf\ncore.attributesfile /x')).toBe(false)
    expect(autocrlfConverts('core.eol lf\ncore.autocrlf TRUE')).toBe(true)
  })
})
