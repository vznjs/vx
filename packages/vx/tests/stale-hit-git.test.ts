// Stale-cache-hit regressions, continued from stale-hit.test.ts: split so
// neither file holds a test shard alone (117 s as one file, 2026-10-22).
// The same shape: the real CLI against a real git-backed fixture.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

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
           inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
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
               inputs: { files: ['**/*'] }, outputs: { files: ['data'] }, cache: true,
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

  // The second row negates the outputs out of the inputs, as the docs advise
  // (`!dist/**`): the negation dropped the committed file from the key too,
  // and a committed edit hit and was overwritten (2026-11-10).
  for (const inputs of [`['src/**']`, `['**', '!dist/**', '!vx.config.mjs']`])
    it(
      `an edit to a committed file under its own output moves the key though no input glob reaches it (${inputs})`,
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
               inputs: { files: ${inputs} }, outputs: { files: ['dist/**'] }, cache: true,
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
               inputs: { files: ['routes/**', 'src/**'], stability: { severity: 'error' } },
               outputs: { files: ['src/routeTree.gen.ts'] },
               cache: true,
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

  // No clean deletes a committed file (2026-10-14), so a hit cannot replay
  // a run that removed one: the restore left it, and the tree a hit left
  // (a fresh CI checkout's) held a file the run took away, restored on
  // every run after. Such a run saves nothing, as X-32 has it.
  for (const shape of ['files', 'workspaceFiles'] as const)
    it(
      `a run that removes a committed file under its outputs saves nothing (${shape})`,
      async () => {
        await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
        await writeLocalWorkspace(root)
        const outputs =
          shape === 'files'
            ? `{ files: ['dist/**'] }`
            : `{ files: [], workspaceFiles: ['dist/**'] }`
        await write(
          path.join(root, 'vx.config.mjs'),
          `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && rm -f dist/tracked.txt && cat src/a.txt > dist/a' },
               inputs: { files: ['src/**'] }, outputs: ${outputs}, cache: true,
             },
           },
         }`,
        )
        await write(path.join(root, 'src/a.txt'), 'a')
        await write(path.join(root, 'dist/tracked.txt'), 'T')
        await write(path.join(root, '.gitignore'), '.vx/cache/\ndist/a\n')
        git(root, 'init', '-q')
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'initial')

        await writeLocalWorkspace(root)
        vx(root, 'run', 'build')
        git(root, 'checkout', '--', 'dist/tracked.txt')
        expect(vx(root, 'run', 'build')).not.toMatch(/build[^\n]*(up-to-date|restored)/)
        expect(await readdir(path.join(root, 'dist'))).toEqual(['a'])
        // With the file gone the key moves, and that run saves as usual.
        expect(vx(root, 'run', 'build')).toContain('local 1↑')
        expect(vx(root, 'run', 'build')).toMatch(/build[^\n]*up-to-date/)
      },
      TIMEOUT,
    )

  // No clean deletes a committed file, so attempt 1's `HALF` stayed for
  // attempt 2 to pass beside, the pass was saved under the tree's key, and
  // a hit after `git checkout` wrote `HALF` over the committed file.
  for (const [scope, file, half, clean] of [
    ['project', 'p/gen/route.ts', 'gen/route.ts', true],
    ['workspace', 'wsgen/route.ts', '../wsgen/route.ts', true],
    ['project (outputs.clean: false)', 'p/gen/route.ts', 'gen/route.ts', false],
    ['workspace (outputs.clean: false)', 'wsgen/route.ts', '../wsgen/route.ts', false],
  ] as const)
    it(
      `a retry that passes is not saved when a failed attempt changed a committed ${scope} output`,
      async () => {
        await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
        await writeLocalWorkspace(root)
        const marker = path.join(root, 'tried')
        await write(
          path.join(root, 'p/vx.config.mjs'),
          `export default { tasks: { build: {
             exec: {
               command: 'if [ ! -f ${marker} ]; then touch ${marker}; echo HALF > ${half}; exit 1; fi; mkdir -p gen; echo ok > gen/out.js',
               retries: 1,
             },
             inputs: { files: ['src/**'] },
             outputs: { files: ['gen/**'], workspaceFiles: ['wsgen/**'], clean: ${clean} },
             cache: true,
           } } }`,
        )
        await write(path.join(root, 'p/src/a'), 'x')
        await write(path.join(root, file), 'original\n')
        await write(path.join(root, '.gitignore'), '.vx/cache/\ntried\n')
        git(root, 'init', '-q')
        expect(vx(root, 'lock')).not.toMatch(/✗/)
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'initial')

        expect(vx(root, 'run', 'p#build')).toMatch(/2 attempts/)
        git(root, 'checkout', '--', file)
        expect(vx(root, 'run', 'p#build')).not.toMatch(/restored|up-to-date/)
        expect(await readFile(path.join(root, file), 'utf8')).toBe('original\n')
        // The clean run that followed is the entry.
        await rm(path.join(root, 'p/gen/out.js'))
        expect(vx(root, 'run', 'p#build')).toMatch(/p#build[^\n]*restored-local/)
        expect(await readFile(path.join(root, file), 'utf8')).toBe('original\n')
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
               outputs: { files: [], workspaceFiles: ['gen/**'] },
               cache: true,
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
               outputs: { files: ['out/**'] },
               cache: true,
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
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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

  // The index's stat cannot stand in for a file's lstat under a text
  // filter (2026-11-11): git called this same-size rewrite clean by
  // content after normalizing and kept the old stat, so a token built from
  // the index held while the bytes the task reads moved.
  it(
    'a same-size line-ending swap git calls clean is not served from cache',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeLocalWorkspace(root)
      const proj = path.join(root, 'packages', 'app')
      await write(path.join(proj, 'package.json'), '{"name":"app","version":"1.0.0"}')
      await write(
        path.join(proj, 'vx.config.mjs'),
        `export default {
           tasks: {
             own: {
               exec: { command: 'mkdir -p dist && cat src/a.txt > dist/own.txt' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/own.txt'] }, cache: true,
             },
             ws: {
               exec: { command: 'mkdir -p dist && cat ../../shared/a.txt > dist/ws.txt' },
               inputs: { files: [], workspaceFiles: ['shared/**'] },
               outputs: { files: ['dist/ws.txt'] }, cache: true,
             },
           },
         }`,
      )
      await write(path.join(root, '.gitattributes'), '* text=auto eol=lf\n')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
      const files = [path.join(proj, 'src/a.txt'), path.join(root, 'shared/a.txt')]
      for (const f of files) await write(f, 'a\r\nb\n')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      const out = (task: string) => readFile(path.join(proj, `dist/${task}.txt`), 'utf8')
      for (const task of ['own', 'ws']) {
        vx(root, 'run', `app#${task}`)
        vx(root, 'run', `app#${task}`)
        expect(await out(task)).toBe('a\r\nb\n')
      }
      for (const f of files) await write(f, 'a\nb\r\n')
      const status = Bun.spawnSync({
        cmd: ['git', '--no-optional-locks', 'status', '--porcelain', '--', 'packages', 'shared'],
        cwd: root,
      })
      expect(new TextDecoder().decode(status.stdout)).toBe('')
      const got: string[] = []
      for (const task of ['own', 'ws']) {
        vx(root, 'run', `app#${task}`)
        got.push(JSON.stringify(await out(task)))
      }
      expect(got).toEqual([JSON.stringify('a\nb\r\n'), JSON.stringify('a\nb\r\n')])
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
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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

  // git reads a relative `core.attributesFile` from the repo's top level;
  // the gate looked for it under the workspace root, so with the workspace
  // in a subdirectory it found nothing and trusted the index: a clean
  // filter hid the edit from `git status` and the run replayed old bytes.
  it(
    'a relative core.attributesFile is found from the repo top, not the workspace',
    async () => {
      const ws = path.join(root, 'ws')
      await write(path.join(ws, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(ws)
      await write(
        path.join(ws, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' },
           inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
         } } }`,
      )
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
      await write(path.join(ws, 'src/a.txt'), 'abc\n')
      await write(path.join(root, 'myattrs'), '*.txt filter=low\n')
      git(root, 'init', '-q')
      git(root, 'config', 'filter.low.clean', 'tr A-Z a-z')
      git(root, 'config', 'filter.low.smudge', 'cat')
      git(root, 'config', 'core.attributesFile', 'myattrs')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      vx(ws, 'run', 'build')
      expect(await readFile(path.join(ws, 'dist/out.txt'), 'utf8')).toBe('abc\n')
      await write(path.join(ws, 'src/a.txt'), 'Abc\n')
      vx(ws, 'run', 'build')
      expect(await readFile(path.join(ws, 'dist/out.txt'), 'utf8')).toBe('Abc\n')
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
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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
                 inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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
})
