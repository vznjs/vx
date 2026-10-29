// Stale-cache-hit regressions, continued from stale-hit.test.ts: split so
// neither file holds a test shard alone (117 s as one file, 2026-10-22).
// The same shape: the real CLI against a real git-backed fixture.

import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { affectedProjects } from '../src/workspace/index.js'
import {
  GitFilesCache,
  attributeFilesOutsideTree,
  autocrlfConverts,
  gitStatWeakened,
  parseCheckAttrOutput,
  populateGitFilesCache,
} from '../src/cache/inputs.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

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
  // A runner that parsed `git status` lost every change once the repo set
  // status colours or short status, and paths git quoted did not match.
  it(
    'repo git config for colour, short status and quoted paths still sees an edit',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'a/vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'cat src/* > out.txt' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
         } } }`,
      )
      const file = path.join(root, 'a/src/zaż "ó"\tx.txt')
      await write(file, 'v1')
      await write(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
      git(root, 'init', '-q')
      for (const [k, v] of [
        ['color.ui', 'always'],
        ['color.status', 'always'],
        ['color.diff', 'always'],
        ['status.short', 'true'],
        ['status.branch', 'true'],
        ['core.quotePath', 'true'],
      ])
        git(root, 'config', k!, v!)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      expect(vx(root, 'lock')).not.toMatch(/✗/)
      expect(vx(root, 'run', 'a#build')).not.toMatch(/up-to-date/)
      expect(vx(root, 'run', 'a#build')).toMatch(/a#build[^\n]*up-to-date/)
      await write(file, 'v2')
      expect(vx(root, 'show', '--affected=HEAD')).toMatch(/^  a +a +1 task$/m)
      expect(vx(root, 'run', 'a#build')).not.toMatch(/up-to-date/)
      expect(await readFile(path.join(root, 'a/out.txt'), 'utf8')).toBe('v2')
    },
    TIMEOUT,
  )

  it(
    'an edit to a committed file under its own output moves the key',
    async () => {
      // `data/sponsors.json` is committed under the task's own `data`
      // output, and the build reads it. An output is out of its own key, so
      // a committed one stays IN it (`committedFiles`): left out, an edit to
      // it hit and replayed the old build. The build also rewrites it,
      // which keeps the save: the bytes it leaves are an output.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'cp data/sponsors.json data/sponsors.json.tmp && mv data/sponsors.json.tmp data/sponsors.json && mkdir -p data && cp data/sponsors.json data/gen.json' },
               inputs: { files: ['**/*'] }, cache: { outputs: { files: ['data'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'data/sponsors.json'), '["a"]')
      await write(path.join(root, '.gitignore'), '.vx/cache/\ndata/gen.json\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      expect(vx(root, 'run', 'build')).not.toMatch(/not saved/)
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await write(path.join(root, 'data/sponsors.json'), '["b"]')
      const third = vx(root, 'run', 'build')
      expect(third).not.toMatch(/build[^\n]*up-to-date/)
      expect(await readFile(path.join(root, 'data/gen.json'), 'utf8')).toBe('["b"]')
      expect(await readFile(path.join(root, 'data/sponsors.json'), 'utf8')).toBe('["b"]')
    },
    TIMEOUT,
  )

  it(
    'an edit to a committed file under its own output moves the key though no input glob reaches it',
    async () => {
      // `dist/LICENSE` is committed under `dist/**`, outside `src/**`. A hit
      // writes the artifact's copy of it back, so the key must fold it: left
      // out, a committed edit hit and the restore put the old bytes back
      // (turborepo#14831).
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/a.txt'), 'a')
      await write(path.join(root, 'dist/LICENSE'), 'license v1')
      await write(path.join(root, '.gitignore'), '.vx/cache/\ndist/out.txt\n')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'build')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      await write(path.join(root, 'dist/LICENSE'), 'license v2')
      git(root, 'commit', '-q', '-am', 'license v2')
      expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
      expect(await readFile(path.join(root, 'dist/LICENSE'), 'utf8')).toBe('license v2')
    },
    TIMEOUT,
  )

  it(
    'a codegen that rewrites its committed output is saved, and a hit writes what it left',
    async () => {
      // TanStack Router's committed `routeTree.gen.ts`, declared an output
      // (item 1015): a new route makes the build write new bytes there. The
      // key folded the old bytes, so the run is saved under it, and a hit
      // on that state writes the new bytes, as the run would. Keyed as a
      // plain input, the rewrite read as an input moved mid-run: not saved,
      // and a failure under `inputStability.severity: 'error'`.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'ls routes > src/routeTree.gen.ts' },
               inputs: { files: ['routes/**', 'src/**'] },
               cache: {
                 outputs: { files: ['src/routeTree.gen.ts'] },
                 inputStability: { severity: 'error' },
               },
             },
           },
         }`,
      )
      await write(path.join(root, 'routes/a.tsx'), 'a')
      await write(path.join(root, 'src/routeTree.gen.ts'), 'a.tsx\n')
      await write(path.join(root, '.gitignore'), '.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      await write(path.join(root, 'routes/b.tsx'), 'b')
      expect(vx(root, 'run', 'build')).not.toMatch(/changed after its key/)
      expect(await readFile(path.join(root, 'src/routeTree.gen.ts'), 'utf8')).toBe('a.tsx\nb.tsx\n')
      git(root, 'checkout', '--', 'src/routeTree.gen.ts')
      expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*restored-local/)
      expect(await readFile(path.join(root, 'src/routeTree.gen.ts'), 'utf8')).toBe('a.tsx\nb.tsx\n')
    },
    TIMEOUT,
  )

  it(
    'a committed file under a root-anchored output survives the clean before a run',
    async () => {
      // The twin of the project case above: `cleanWorkspaceOutputs` can
      // reach another project's directory, and leaves committed files too.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             codegen: {
               exec: { command: 'sh emit.sh' },
               inputs: { files: ['emit.sh'] },
               cache: {
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
               cache: {
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
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf a > gen/a.js\n')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')
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
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/a.txt'), 'A')
      await write(path.join(root, 'src/sparse.txt'), 'SPARSE')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
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

  // Each flag, edited in place: removing the file (the row above) is
  // also caught by the save's moved-input check, which masked the `S`
  // half of the guard (A-33).
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    it(
      `editing an input flagged ${flag} moves the key`,
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
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
        )
        await write(path.join(root, 'src/a.txt'), 'A')
        await write(path.join(root, '.gitignore'), 'dist/\n')
        await write(path.join(root, '.vx/.gitignore'), '/cache\n')
        git(root, 'init', '-q')
        git(root, 'config', 'user.email', 'test@vx.local')
        git(root, 'config', 'user.name', 'vx test')
        // Committed with the rest, so the status below holds only the flagged file.
        vx(root, 'lock')
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'initial')

        git(root, 'update-index', flag, 'src/a.txt')
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
  }

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
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitattributes'), '* text=auto\n')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
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
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitattributes'), '* text=auto\n')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
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

  // Row X of the upstream survey: git's DEFAULT global attributes file,
  // read when `core.attributesFile` is unset, is `$XDG_CONFIG_HOME/git/
  // attributes`, else `~/.config/git/attributes`. The gate looked for the
  // in-tree files, `info/attributes` and the config key, never for it, so
  // `* text` there left the CRLF file's LF blob trusted: up-to-date, 10
  // bytes, while the file held 8.
  for (const where of ['HOME', 'XDG_CONFIG_HOME'] as const) {
    it(
      `a text rule in the global attributes file under ${where} is not served from cache`,
      async () => {
        const home = await mkdtemp(path.join(os.tmpdir(), 'vx-home-'))
        try {
          const config = where === 'HOME' ? path.join(home, '.config') : path.join(home, 'xdg')
          await write(path.join(config, 'git', 'attributes'), '* text\n')
          const env: Record<string, string | undefined> = {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: where === 'HOME' ? undefined : config,
            CI: '',
            GITHUB_ACTIONS: '',
            NO_COLOR: '1',
          }
          if (where === 'HOME') delete env.XDG_CONFIG_HOME
          const run = (): void => {
            Bun.spawnSync({ cmd: ['bun', CLI, 'run', 'build'], cwd: root, env, stdout: 'pipe' })
          }
          await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
          await writeLocalWorkspace(root)
          await write(
            path.join(root, 'vx.config.mjs'),
            `export default { tasks: { build: {
               exec: { command: 'mkdir -p dist && wc -c < src/a.txt > dist/out.txt' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             } } }`,
          )
          await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
          await write(path.join(root, 'src/a.txt'), 'one\r\ntwo\r\n')
          git(root, 'init', '-q')
          git(root, 'add', '-A')
          git(root, 'commit', '-q', '-m', 'initial')
          // The helper's git runs under the real HOME; the index is plain
          // CRLF there. Re-stage under the fixture HOME so `* text` stores
          // the LF blob, as a user with that file would have.
          Bun.spawnSync({ cmd: ['git', 'rm', '-q', '--cached', 'src/a.txt'], cwd: root, env })
          Bun.spawnSync({ cmd: ['git', 'add', 'src/a.txt'], cwd: root, env })
          Bun.spawnSync({
            cmd: [
              'git',
              '-c',
              'user.email=t@vx',
              '-c',
              'user.name=t',
              '-c',
              'commit.gpgsign=false',
              'commit',
              '-qm',
              'lf',
            ],
            cwd: root,
            env,
          })
          await write(path.join(root, 'src/a.txt'), 'one\r\ntwo\r\n')

          run()
          expect((await readFile(path.join(root, 'dist/out.txt'), 'utf8')).trim()).toBe('10')
          await write(path.join(root, 'src/a.txt'), 'one\ntwo\n')
          run()
          expect((await readFile(path.join(root, 'dist/out.txt'), 'utf8')).trim()).toBe('8')
        } finally {
          await rm(home, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }

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
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
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

  for (const [key, value] of [
    ['core.trustctime', 'false'],
    ['core.checkStat', 'minimal'],
  ] as const) {
    it(
      `${key}=${value}: a same-size rewrite that keeps its mtime is a miss (A-6)`,
      async () => {
        // git then judges the file by mtime and size alone (with minimal,
        // whole seconds): `cp -p` or `tar -x` over a tracked input reads
        // clean, and its index OID keyed the old bytes.
        await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
        await writeLocalWorkspace(root)
        await write(
          path.join(root, 'vx.config.mjs'),
          `export default {
             tasks: {
               build: {
                 exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' },
                 inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
               },
             },
           }`,
        )
        await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
        const src = path.join(root, 'src/a.txt')
        await write(src, 'AAAA')
        // An mtime well before the index is written, so git's own racy
        // check does not re-read the file.
        const old = new Date(1_600_000_000_000)
        await utimes(src, old, old)
        git(root, 'init', '-q')
        git(root, 'config', 'user.email', 'test@vx.local')
        git(root, 'config', 'user.name', 'vx test')
        git(root, 'config', key, value)
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'initial')

        vx(root, 'run', 'build')
        expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('AAAA')
        await writeFile(src, 'BBBB')
        await utimes(src, old, old)
        vx(root, 'run', 'build')
        expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('BBBB')
      },
      TIMEOUT,
    )
  }

  it(
    'the index OIDs are kept under the default stat and dropped under a weakened one',
    async () => {
      await write(path.join(root, 'src/a.txt'), 'AAAA')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      // Pinned here: a machine's global config may weaken either (this
      // container's does both).
      git(root, 'config', 'core.trustctime', 'true')
      git(root, 'config', 'core.checkStat', 'default')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      const trusted = async (): Promise<boolean> => {
        const memo = new GitFilesCache()
        await populateGitFilesCache(root, [root], memo)
        return memo.oidsFor(root)?.has(path.join(root, 'src/a.txt')) === true
      }
      expect(await trusted()).toBe(true)
      git(root, 'config', 'core.checkStat', 'minimal')
      expect(await trusted()).toBe(false)
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
      expect(seen.some((cmd) => cmd.at(-2) === 'var' && cmd.at(-1) === '-l')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a .gitattributes naming no converting attribute never runs check-attr',
    async () => {
      // `.vx/.gitattributes` marks the lock `linguist-generated`, which
      // converts nothing; any .gitattributes used to cost a check-attr per
      // run (21 ms). Control: a `text` line in the same file does run it.
      await write(path.join(root, 'pkg/src/a.ts'), 'export const a = 1')
      await write(path.join(root, 'pkg/.gitattributes'), 'projects.lock.json linguist-generated\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      const checkAttrRuns = async (): Promise<boolean> => {
        const origSpawn = Bun.spawn
        const seen: string[][] = []
        const bunMut = Bun as unknown as { spawn: typeof Bun.spawn }
        bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
          const opt = a[0] as { cmd?: readonly string[] } | undefined
          if (opt && Array.isArray(opt.cmd) && path.basename(opt.cmd[0] ?? '') === 'git')
            seen.push([...opt.cmd])
          return origSpawn(...a)
        }) as typeof Bun.spawn
        try {
          await populateGitFilesCache(root, [path.join(root, 'pkg')], new GitFilesCache())
        } finally {
          bunMut.spawn = origSpawn
        }
        return seen.some((cmd) => cmd.includes('check-attr'))
      }
      const generatedOnly = await checkAttrRuns()
      await write(path.join(root, 'pkg/.gitattributes'), '*.ts text eol=lf\n')
      git(root, 'commit', '-qam', 'text')
      expect([generatedOnly, await checkAttrRuns()]).toEqual([false, true])
    },
    TIMEOUT,
  )

  it(
    'a tracked .gitattributes starts check-attr before status has answered (U-3)',
    async () => {
      // check-attr waited for status, the one spawn that walks the tree, and
      // ran after it: ~8 ms of a warm run on this repo, whose root
      // `.gitattributes` sets a merge driver. The index listing alone proves
      // the gate will fire. Status is held here until check-attr starts or a
      // second passes, and only the first is the fix.
      await write(path.join(root, '.gitattributes'), '*.txt text\n')
      await write(path.join(root, 'pkg/src/a.txt'), 'a\n')
      await write(path.join(root, 'pkg/src/b.ts'), 'export const b = 1\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      const origSpawn = Bun.spawn
      const bunMut = Bun as unknown as { spawn: typeof Bun.spawn }
      let attrStarted!: () => void
      const attr = new Promise<'check-attr'>((r) => (attrStarted = () => r('check-attr')))
      let released: string | undefined
      bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
        const cmd = (a[0] as { cmd?: readonly string[] } | undefined)?.cmd ?? []
        const proc = origSpawn(...a)
        if (path.basename(cmd[0] ?? '') !== 'git') return proc
        if (cmd.includes('check-attr')) attrStarted()
        if (!cmd.includes('status')) return proc
        const gate = Promise.race([attr, Bun.sleep(1000).then(() => 'timeout')])
        return new Proxy(proc, {
          get(target, key) {
            if (key === 'exited') {
              return gate.then((by) => {
                released = by
                return target.exited
              })
            }
            const v = Reflect.get(target, key, target) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        })
      }) as typeof Bun.spawn
      const cache = new GitFilesCache()
      try {
        await populateGitFilesCache(root, [path.join(root, 'pkg')], cache)
      } finally {
        bunMut.spawn = origSpawn
      }
      expect(released).toBe('check-attr')
      // And its answer still lands: the text file is hashed from disk, the
      // other keeps its index OID.
      const oids = cache.oidsFor(path.join(root, 'pkg'))
      expect(oids?.has(path.join(root, 'pkg/src/a.txt'))).toBe(false)
      expect(oids?.has(path.join(root, 'pkg/src/b.ts'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a workspace-anchored OUTPUT landing in the consumer project is not classified stable',
    async () => {
      // `cache.outputs.workspaceFiles` is root-anchored and deliberately
      // boundary-IGNORING — it may write inside ANOTHER project's dir. So a
      // consumer in that project, reading the same path with an ordinary
      // PROJECT-RELATIVE `inputs.files`, has a preliminary key until the
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
          '  inputs: { files: ["src/**"] },',
          '  cache: {',
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
          '  inputs: { files: ["gen/**"], tasks: [] }, cache: { outputs: { files: ["dist/**"] } },',
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

  // turborepo#1103: git printing a warning while the inputs were enumerated
  // changed the hash. vx reads only `-z` stdout and the exit code.
  it(
    'git warning on stderr during the attribute check leaves the key where a quiet git puts it',
    async () => {
      const keyWith = async (attributes: string): Promise<{ hash: string; warned: boolean }> => {
        const ws = await mkdtemp(path.join(root, 'ws-'))
        await write(path.join(ws, 'package.json'), '{"name":"r","private":true}')
        await writeLocalWorkspace(ws)
        await write(
          path.join(ws, 'vx.config.mjs'),
          `export default {
             tasks: {
               build: {
                 exec: { command: 'cat src/a.txt' },
                 inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
               },
             },
           }`,
        )
        await write(path.join(ws, '.gitattributes'), attributes)
        await write(path.join(ws, 'src/a.txt'), 'a\r\n')
        await write(path.join(ws, 'src/b.txt'), 'b\n')
        git(ws, 'init', '-q')
        git(ws, 'add', '-A')
        git(ws, 'commit', '-q', '-m', 'initial')
        // The index holds a.txt as LF, the tree as CRLF: the key is right
        // only if the attribute check ran to the end and untrusted the OID.
        await write(path.join(ws, 'src/a.txt'), 'a\r\n')
        const attr = Bun.spawnSync({
          cmd: ['git', 'check-attr', 'text', '--', 'src/a.txt'],
          cwd: ws,
          stderr: 'pipe',
        })
        const dry = JSON.parse(vx(ws, 'run', 'build', '--dry=json')) as {
          tasks: Array<{ hash: string }>
        }
        return { hash: dry.tasks[0]!.hash, warned: attr.stderr.toString().length > 0 }
      }
      // The same rule both times; the negated line is one git ignores
      // aloud, so it changes what git prints and nothing it decides.
      const quiet = await keyWith('*.txt text\n')
      const noisy = await keyWith('*.txt text\n!nothing text\n')
      expect(quiet.warned).toBe(false)
      expect(noisy.warned).toBe(true)
      expect(noisy.hash).toBe(quiet.hash)
    },
    TIMEOUT,
  )

  // nx#23106: the key held the input's content but not its name, so a
  // rename replayed the entry built under the old name.
  it(
    'renaming an input misses and back again restores only the outputs of that name',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && for f in src/*.ts; do cp "$f" "dist/$(basename "$f" .ts).js"; done' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
      await write(path.join(root, 'src/a.ts'), 'same bytes\n')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      const dist = async () => (await readdir(path.join(root, 'dist'))).sort()
      const renameTo = async (from: string, to: string) => {
        await rename(path.join(root, 'src', from), path.join(root, 'src', to))
      }
      const status = () => {
        const out = vx(root, 'run', 'build')
        return /up-to-date|restored/.test(out) ? 'hit' : 'miss'
      }

      expect(status()).toBe('miss')
      expect(await dist()).toEqual(['a.js'])
      await renameTo('a.ts', 'b.ts')
      expect(status()).toBe('miss')
      expect(await dist()).toEqual(['b.js'])
      await renameTo('b.ts', 'a.ts')
      expect(status()).toBe('hit')
      expect(await dist()).toEqual(['a.js'])
      await renameTo('a.ts', 'b.ts')
      expect(status()).toBe('hit')
      expect(await dist()).toEqual(['b.js'])
    },
    TIMEOUT,
  )
})

// turborepo#9345: a name holding a byte that is not UTF-8 (`x\xffy`) came
// back from git's `-z` output, and from `Bun.Glob`, decoded lossily as
// `x�y`, which names no file. An input by that name was never read
// (every edit a hit), an output never saved (every hit a tree without it).
// vx cannot open such a name, so it refuses it by name. macOS refuses to
// create one at all (APFS and HFS+ require UTF-8 names), so there is
// nothing to hold there.
describe.skipIf(process.platform === 'darwin')('a name that is not UTF-8', () => {
  const BAD = Buffer.from([0x78, 0xff, 0x79]) // x, 0xFF, y

  function vxExit(cwd: string, ...args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync({
      cmd: ['bun', CLI, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    }
  }

  async function project(command: string): Promise<string> {
    await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
    await writeLocalWorkspace(root)
    await write(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: ${JSON.stringify(command)} },
         inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
       } } }\n`,
    )
    await write(path.join(root, 'src', 'a'), 'v1')
    await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
    return path.join(root, 'src')
  }
  const badIn = (dir: string): Buffer => Buffer.concat([Buffer.from(`${dir}/`), BAD])

  for (const tracked of [false, true]) {
    it(
      `${tracked ? 'a tracked' : 'an untracked'} input by that name is refused, not dropped`,
      async () => {
        const src = await project('mkdir -p dist && cat src/* > dist/all')
        await writeFile(badIn(src), 'bad1')
        git(root, 'init', '-q')
        if (tracked) {
          git(root, 'add', '-A')
          git(root, 'commit', '-q', '-m', 'init')
        }
        const first = vxExit(root, 'run', 'build')
        expect([first.code, first.out]).toEqual([1, expect.stringContaining('src/x�y')])
        expect(first.out).toContain('not valid UTF-8')
        // CONTROL: the same file under a UTF-8 name is an input like any other.
        await rm(badIn(src))
        await write(path.join(src, 'xy'), 'bad1')
        expect(vxExit(root, 'run', 'build').code).toBe(0)
        expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('v1bad1')
      },
      TIMEOUT,
    )
  }

  it(
    'such a name fails only the task that reads it; the rest hit and --affected selects its owner (vercel/turborepo#11106, vercel/turborepo#12826)',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","workspaces":["pkgs/*"]}')
      await writeLocalWorkspace(root)
      for (const p of ['a', 'b']) {
        await write(path.join(root, 'pkgs', p, 'package.json'), `{"name":"${p}"}`)
        await write(
          path.join(root, 'pkgs', p, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n`,
        )
        await write(path.join(root, 'pkgs', p, 'src', 'i'), '1')
      }
      await writeFile(badIn(path.join(root, 'pkgs', 'a', 'src')), 'bad1')
      // One outside every project, which no task reads.
      await write(path.join(root, 'docs', 'ok'), '1')
      await writeFile(badIn(path.join(root, 'docs')), 'doc1')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const first = vxExit(root, 'run', 'build', '--all')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('src/x\uFFFDy')])
      expect(first.out).toContain('not valid UTF-8')
      // The row's words, not their spacing: a run that sampled a task's CPU
      // adds columns between them (CI, PR #4867).
      const row = first.out.split('\n').find((l) => l.endsWith(' b#build'))
      expect(row?.trim().split(/ +/)).toEqual(expect.arrayContaining(['success', 'miss']))
      expect(vxExit(root, 'run', 'build', '--filter', 'b').out).toContain('local 1✓')
      await writeFile(badIn(path.join(root, 'pkgs', 'a', 'src')), 'bad2')
      await writeFile(badIn(path.join(root, 'docs')), 'doc2')
      git(root, 'commit', '-q', '-am', 'edit the odd names')
      const projects = ['a', 'b'].map((name) => ({
        name,
        dir: path.join(root, 'pkgs', name),
        packageJson: { name } as never,
        configPath: null,
      }))
      expect([
        ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })),
      ]).toEqual(['a'])
    },
    TIMEOUT,
  )

  it(
    'one inside an embedded repository is refused too, not dropped',
    async () => {
      // The outer repo lists `src/vendor/` alone; vx asks its own git for
      // the files, and that listing carries the name too (A-33).
      const src = await project('mkdir -p dist && cat src/*/* > dist/all')
      const vendor = path.join(src, 'vendor')
      await write(path.join(vendor, 'ok'), 'o')
      await writeFile(badIn(vendor), 'bad1')
      git(vendor, 'init', '-q')
      git(vendor, 'add', '-A')
      git(vendor, 'commit', '-q', '-m', 'init')
      git(root, 'init', '-q')
      const first = vxExit(root, 'run', 'build')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('src/vendor/x�y')])
      expect(first.out).toContain('not valid UTF-8')
    },
    TIMEOUT,
  )

  it(
    'a workspaceFiles input by that name is refused too, not dropped',
    async () => {
      // The workspace half keeps its own copy of the refusal (A-31).
      await project('mkdir -p dist && cat shared/* > dist/all')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && cat shared/* > dist/all' },
           inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      await write(path.join(root, 'shared', 'ok'), 'o')
      await writeFile(badIn(path.join(root, 'shared')), 'bad1')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const first = vxExit(root, 'run', 'build')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('shared/x�y')])
      expect(first.out).toContain('not valid UTF-8')
      // CONTROL: the same file under a UTF-8 name is an input like any other.
      await rm(badIn(path.join(root, 'shared')))
      await write(path.join(root, 'shared', 'xy'), 'bad1')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('obad1')
    },
    TIMEOUT,
  )

  // CONTROL past the gate: a name that really holds U+FFFD is valid UTF-8,
  // reads like any other, and must not be taken for a lossy one.
  it(
    'a name that holds U+FFFD as a character is an input like any other',
    async () => {
      const src = await project('mkdir -p dist && cat src/* > dist/all')
      await write(path.join(src, 'x\ufffdy'), 'fine1')
      git(root, 'init', '-q')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('v1fine1')
      await write(path.join(src, 'x\ufffdy'), 'fine2')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('v1fine2')
    },
    TIMEOUT,
  )

  it(
    'an output by that name fails the save by name, so no hit restores a tree without it',
    async () => {
      await project(`mkdir -p dist && printf a > dist/ok && printf b > "dist/$(printf 'x\\377y')"`)
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const first = vxExit(root, 'run', 'build')
      expect(first.out).toContain('dist/x�y')
      expect(first.out).toContain('not valid UTF-8')
      await rm(path.join(root, 'dist'), { recursive: true, force: true })
      const second = vxExit(root, 'run', 'build')
      expect(second.out).not.toContain('restored')
      expect(second.out).not.toMatch(/ \d+✓/)
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
    expect(autocrlfConverts('core.autocrlf=true')).toBe(true)
    expect(autocrlfConverts('core.autocrlf=input')).toBe(true)
    expect(autocrlfConverts('core.autocrlf=false')).toBe(false)
    expect(autocrlfConverts('')).toBe(false)
    // Other core.* keys in the same output must not be mistaken for it.
    expect(autocrlfConverts('core.eol=lf\ncore.attributesfile=/x')).toBe(false)
    expect(autocrlfConverts('core.eol=lf\ncore.autocrlf=TRUE')).toBe(true)
    // The last value wins, as it does in git.
    expect(autocrlfConverts('core.autocrlf=true\ncore.autocrlf=false')).toBe(false)
  })

  // Git reads `yes`, `on`, a nonzero integer and a bare key as true; only
  // `true` was taken, so `autocrlf = 1` read as no conversion.
  it('takes every spelling git reads as true', () => {
    for (const v of ['yes', 'on', '1', '2k', 'On']) {
      expect(autocrlfConverts(`core.autocrlf=${v}`)).toBe(true)
    }
    expect(autocrlfConverts('core.autocrlf=false\ncore.autocrlf')).toBe(true)
  })
})

describe('gitStatWeakened', () => {
  it('is true for a ctime git does not trust or a minimal stat, and only then', () => {
    // Git reads an empty value and any zero integer (`00`, `-0`, `0k`) as
    // false too: `trustctime =` kept index OIDs trusted, and a same-size
    // rewrite with its mtime kept replayed the old output.
    for (const v of ['false', 'no', 'off', '0', 'FALSE', '', '00', '-0', '0k', ' 0 ']) {
      expect(gitStatWeakened(`core.trustctime=${v}`)).toBe(true)
    }
    // A bare key is true, and the last value wins.
    expect(gitStatWeakened('core.trustctime=false\ncore.trustctime')).toBe(false)
    expect(gitStatWeakened('core.checkstat=minimal')).toBe(true)
    for (const vars of [
      '',
      'core.trustctime=true',
      'core.checkstat=default',
      'core.trustctime=false\ncore.trustctime=true',
    ]) {
      expect(gitStatWeakened(vars)).toBe(false)
    }
  })
})

// The files the gate stats, from `git var -l`. A git from 2.42 names them;
// an older one does not, and the documented lookup stands in.
describe('attributeFilesOutsideTree', () => {
  const env = { HOME: '/h' }
  it('takes both files from a git that names them, and nothing else', () => {
    const listing = [
      'core.attributesfile=/ignored',
      'GIT_ATTR_SYSTEM=/sys/gitattributes',
      'GIT_ATTR_GLOBAL=/h/.config/git/attributes',
      'GIT_CONFIG_GLOBAL=/h/.gitconfig',
    ].join('\n')
    expect(attributeFilesOutsideTree(listing, env)).toEqual([
      '/h/.config/git/attributes',
      '/sys/gitattributes',
    ])
    // Under GIT_ATTR_NOSYSTEM git leaves the system line out; so does this.
    expect(
      attributeFilesOutsideTree('GIT_ATTR_GLOBAL=/g\nGIT_CONFIG_GLOBAL=/h/.gitconfig', env),
    ).toEqual(['/g'])
  })

  it('mirrors the global lookup for a git that does not name it', () => {
    const global = (listing: string, e: Record<string, string>) =>
      attributeFilesOutsideTree(listing, { ...e, GIT_ATTR_NOSYSTEM: '1' })
    expect(global('core.attributesfile=~/attrs', env)).toEqual(['/h/attrs'])
    expect(global('core.attributesfile=/abs', { ...env, XDG_CONFIG_HOME: '/x' })).toEqual(['/abs'])
    expect(global('', { ...env, XDG_CONFIG_HOME: '/x' })).toEqual(['/x/git/attributes'])
    // An EMPTY XDG_CONFIG_HOME is unset to git.
    expect(global('', { ...env, XDG_CONFIG_HOME: '' })).toEqual(['/h/.config/git/attributes'])
    expect(global('', env)).toEqual(['/h/.config/git/attributes'])
  })

  it('adds the system file where the build put it, unless GIT_ATTR_NOSYSTEM', () => {
    const files = attributeFilesOutsideTree('', env)
    expect(files[0]).toBe('/h/.config/git/attributes')
    expect(files[1]).toBe('/etc/gitattributes')
    expect(files[2]).toMatch(/\/etc\/gitattributes$/)
    expect(files).toHaveLength(3)
  })
})
