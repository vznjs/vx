// Stale-cache-hit regressions for a committed build output, split from
// stale-hit-git.test.ts so no shard holds the whole of it (one 120 s shard
// timeout, 2026-11-23). A committed output keys by the version git holds
// while this machine can prove its bytes came from such a key.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { git, gitInit } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

const TIMEOUT = 60_000

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args).text

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-stale-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('committed outputs', () => {
  it(
    'a build that rewrites a committed output with new bytes each run hits by its committed version',
    async () => {
      // A committed `dist/` whose build writes a timestamped source map: keyed
      // by the bytes on disk, each run's rewrite moved the next run's key and
      // the build never hit. No input glob reaches the file, so the key folds
      // the version git holds; a staged or committed edit still moves it.
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/index.js && od -An -N8 -tx8 /dev/urandom > dist/index.js.map' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'dist/index.js'), 'a')
      await Bun.write(path.join(root, 'dist/index.js.map'), 'committed')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*up-to-date/)
      const built = await readFile(path.join(root, 'dist/index.js.map'), 'utf8')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      expect(await readFile(path.join(root, 'dist/index.js.map'), 'utf8')).toBe(built)
      // Staged: the version git holds moved, so the key does.
      git(root, 'add', 'dist/index.js.map')
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await Bun.write(path.join(root, 'src/a.txt'), 'b')
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
      expect(await readFile(path.join(root, 'dist/index.js'), 'utf8')).toBe('b')
      // Edit, build, build: the second hits though the map is still dirty.
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await Bun.write(path.join(root, 'src/a.txt'), 'c')
      vx(root, 'run', 'build')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      expect(await readFile(path.join(root, 'dist/index.js'), 'utf8')).toBe('c')
    },
    TIMEOUT,
  )

  it(
    'a committed output a remote hit rewrote still hits on the next run',
    async () => {
      // A fresh clone pulls the build from a remote: the restore rewrites the
      // committed source map with the bytes the other machine built. The hit
      // was keyed by the version git holds, yet the next run keyed the now
      // dirty file by its bytes and missed: a remote ingest wrote no input
      // rows to prove what the restore's key folded.
      const remote = path.join(root, 'remote')
      const a = path.join(root, 'a')
      const b = path.join(root, 'b')
      const plugin = pluginSource(
        'org/dir-remote',
        `{ cache: () => {
            const f = (h) => ${JSON.stringify(remote)} + '/' + h
            return {
              has: async (h) => ((await Bun.file(f(h)).exists()) ? {} : null),
              get: async (h) => ((await Bun.file(f(h)).exists()) ? { body: Bun.file(f(h)), durationMs: undefined } : null),
              put: async (h, body) => { await Bun.write(f(h), await body.arrayBuffer()) },
            }
          } }`,
      )
      await Bun.write(path.join(a, 'package.json'), '{"name":"r","private":true}')
      await Bun.write(path.join(a, '.vx/workspace.mjs'), localWorkspaceSource([plugin]))
      await Bun.write(
        path.join(a, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/index.js && od -An -N8 -tx8 /dev/urandom > dist/index.js.map' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(a, 'src/a.txt'), 'a')
      await Bun.write(path.join(a, 'dist/index.js'), 'a')
      await Bun.write(path.join(a, 'dist/index.js.map'), 'committed')
      await Bun.write(path.join(a, '.gitignore'), '.vx/cache/\n')
      await Bun.write(path.join(remote, '.keep'), '')
      gitInit(a)
      git(a, 'add', '-A')
      git(a, 'commit', '-q', '-m', 'initial')
      git(root, 'clone', '-q', a, b)

      // Off CI a run writes no remote unless told to.
      expect(vx(a, 'run', 'build', '--cache-policy=local:rw,remote:rw')).not.toMatch(
        /build[^\n]*(up-to-date|restored)/,
      )
      const built = await readFile(path.join(a, 'dist/index.js.map'), 'utf8')
      expect(vx(b, 'run', 'build')).toMatch(/build[^\n]*restored/)
      expect(await readFile(path.join(b, 'dist/index.js.map'), 'utf8')).toBe(built)
      expect(vx(b, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      // CONTROL: a hand edit after the restore still moves the key.
      await Bun.write(path.join(b, 'dist/index.js.map'), 'hand')
      expect(vx(b, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
    },
    TIMEOUT,
  )

  it(
    'a hand edit to a committed output no input glob names still moves the key',
    async () => {
      // CONTROL for the index-OID key: it holds only while the file still has
      // the bytes this machine saved or restored under it. An uncommitted edit
      // the build never writes keys by its bytes: the run keeps it, and no
      // entry under the committed key holds it, so a clean tree later gets
      // the committed bytes back (fuzzcout seed 1 wrote the edit over them).
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'dist/LICENSE'), 'license v1')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\ndist/out\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'build')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await Bun.write(path.join(root, 'dist/LICENSE'), 'hand edit')
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
      expect(await readFile(path.join(root, 'dist/LICENSE'), 'utf8')).toBe('hand edit')
      // Saved and stamped by that miss, under a key that folded its bytes:
      // no proof of git's version, so a later miss does not write it back.
      await Bun.write(path.join(root, 'src/a.txt'), 'b')
      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/LICENSE'), 'utf8')).toBe('hand edit')
      git(root, 'checkout', '--', 'dist/LICENSE')
      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/LICENSE'), 'utf8')).toBe('license v1')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'a miss keyed by a committed output it appends to starts from the committed bytes',
    async () => {
      // Keyed by what git holds, the command must also start from it: an
      // append over the last build's bytes saved 'v1 built built' under the
      // key a clean checkout computes, which a checkout then hit (review).
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out && echo built >> dist/LICENSE && chmod a-w dist/LICENSE' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'dist/LICENSE'), 'license v1\n')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\ndist/out\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      // The build leaves it read-only: the write-back replaces it, as a
      // checkout would, rather than opening it.
      const license = () => readFile(path.join(root, 'dist/LICENSE'), 'utf8')
      vx(root, 'run', 'build')
      expect(await license()).toBe('license v1\nbuilt\n')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await Bun.write(path.join(root, 'src/a.txt'), 'b')
      vx(root, 'run', 'build')
      expect(await license()).toBe('license v1\nbuilt\n')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      // A hand edit is never written back: keyed by its bytes, built over.
      await rm(path.join(root, 'dist/LICENSE'))
      await Bun.write(path.join(root, 'dist/LICENSE'), 'hand edit\n')
      vx(root, 'run', 'build')
      expect(await license()).toBe('hand edit\nbuilt\n')
      git(root, 'checkout', '--', 'dist/LICENSE')
      vx(root, 'run', 'build')
      expect(await license()).toBe('license v1\nbuilt\n')
    },
    TIMEOUT,
  )

  it(
    'a task that keeps its outputs still starts from the committed bytes it is keyed by',
    async () => {
      // `outputs.clean: false` skips the clean before the first attempt, and
      // with it the write-back: the append saved 'v1 built built' under the
      // key a clean checkout computes (review).
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out && echo built >> dist/LICENSE' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'], clean: false }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'dist/LICENSE'), 'license v1\n')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\ndist/out\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'build')
      await Bun.write(path.join(root, 'src/a.txt'), 'b')
      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/LICENSE'), 'utf8')).toBe('license v1\nbuilt\n')
    },
    TIMEOUT,
  )

  it(
    'a retry after an attempt that removed the outputs still starts from the committed bytes',
    async () => {
      // The write-back before each attempt found no `dist/` and failed the
      // task before the retry's command ran (review).
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'if [ -f flake ]; then rm -rf dist flake; exit 1; fi; mkdir -p dist && cat src/a.txt > dist/out && echo built >> dist/LICENSE', retries: 1 },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'dist/LICENSE'), 'license v1\n')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\ndist/out\nflake\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'build')
      await Bun.write(path.join(root, 'src/a.txt'), 'b')
      await Bun.write(path.join(root, 'flake'), '')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*success/)
      expect(await readFile(path.join(root, 'dist/LICENSE'), 'utf8')).toBe('license v1\nbuilt\n')
    },
    TIMEOUT,
  )

  it(
    'a task that stages a committed output mid-run re-keys the build after it',
    async () => {
      // The build keys `dist/x` by what git holds. A task before it in the
      // same run `git add`s the edited bytes: keyed by the index the run
      // listed, the build hit the entry built over v1 and wrote v1 back over
      // the staged v2.
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             stage: { exec: { command: 'if [ -f stage-me ]; then git add dist/x; fi' }, cache: false },
             build: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out' },
               dependsOn: ['stage'],
               inputs: { files: ['src/**'], tasks: [] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'dist/x'), 'v1')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\ndist/out\nstage-me\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'build')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await Bun.write(path.join(root, 'dist/x'), 'v2')
      await Bun.write(path.join(root, 'stage-me'), '')
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
      expect(await readFile(path.join(root, 'dist/x'), 'utf8')).toBe('v2')
    },
    TIMEOUT,
  )

  it(
    'a hand edit to a committed output an input glob names still moves the key',
    async () => {
      // CONTROL for the test above: `src/gen.txt` is an output and `src/**`
      // names it, so its bytes on disk key the task. An uncommitted edit must
      // run the task, not restore the entry's bytes over the edit.
      await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await Bun.write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'cat src/gen.txt src/a.txt > out.txt && cp src/gen.txt src/gen.txt.tmp && mv src/gen.txt.tmp src/gen.txt' },
               inputs: { files: ['src/**'] }, outputs: { files: ['src/gen.txt', 'out.txt'] }, cache: true,
             },
           },
         }`,
      )
      await Bun.write(path.join(root, 'src/a.txt'), 'a')
      await Bun.write(path.join(root, 'src/gen.txt'), 'gen v1\n')
      await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'build')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await Bun.write(path.join(root, 'src/gen.txt'), 'gen hand edit\n')
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
      expect(await readFile(path.join(root, 'src/gen.txt'), 'utf8')).toBe('gen hand edit\n')
      expect(await readFile(path.join(root, 'out.txt'), 'utf8')).toBe('gen hand edit\na')
    },
    TIMEOUT,
  )
})
