// Stale-cache-hit regressions. Each case drives the REAL CLI against a real
// git-backed fixture, changes an input, runs again, and asserts vx did NOT
// replay the old artifact. That is what the user actually experiences, and it
// is the only shape that proves the bug: a unit test on the resolver can pass
// while the end-to-end key still collides.
//
// A stale hit is this tool's worst failure — vx reports a hit and hands back
// bytes built from inputs that have since changed. Every case here was
// reproduced against the pre-fix tree before the fix landed.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
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
  it(
    'a mode change re-keys the task: an executable bit, a symlink swapped for a file',
    async () => {
      // A blob OID holds no mode, so both kept the key while `git status`
      // and `--affected` saw the change, and the task replayed its old
      // output, committed or not (item 887). The index path (clean) and
      // the stat path (dirty) must spell the mode alike: the committed
      // state after a dirty miss is a hit.
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeLocalWorkspace(root)
      const pkg = path.join(root, 'packages', 'p')
      await write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
      await write(path.join(pkg, 'src', 'run.sh'), 'echo hi\n')
      await write(path.join(pkg, 'src', 't.txt'), 'real')
      await symlink('t.txt', path.join(pkg, 'src', 'l.txt'))
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && (test -x src/run.sh && echo exec || echo plain) > dist/o && cat src/l.txt >> dist/o' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const out = path.join(pkg, 'dist', 'o')
      const step = async (): Promise<[string, string]> => {
        const said = vx(root, 'run', 'build', '--all')
        const word = / 1↑/.test(said) ? 'miss' : / 1✓/.test(said) ? 'up-to-date' : '?'
        return [word, (await readFile(out, 'utf8')).replace(/\n/g, ' ')]
      }
      const seen: Array<[string, string]> = [await step()]
      await chmod(path.join(pkg, 'src', 'run.sh'), 0o755)
      seen.push(await step())
      git(root, 'commit', '-q', '-am', 'exec')
      seen.push(await step())
      await rm(path.join(pkg, 'src', 'l.txt'))
      await write(path.join(pkg, 'src', 'l.txt'), 't.txt')
      seen.push(await step())
      expect(seen).toEqual([
        ['miss', 'plain real'],
        ['miss', 'exec real'],
        ['up-to-date', 'exec real'],
        ['miss', 'exec t.txt'],
      ])
    },
    TIMEOUT,
  )
  it(
    'a project directory named with glob syntax still keys its files',
    async () => {
      // Port of Vite Task's input_glob_meta_in_path: joined unescaped, the
      // project dir `packages/[lib]` reads as a class matching one of l, i,
      // b, and the task's inputs match nothing.
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await writeLocalWorkspace(root)
      const pkg = path.join(root, 'packages', '[lib]')
      await write(path.join(pkg, 'src', 'main.ts'), 'initial')
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { name: 'lib', tasks: { build: {
           exec: { command: 'mkdir -p dist && cat src/* > dist/o' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const step = async (): Promise<[string, string]> => {
        const said = vx(root, 'run', 'build', '--all')
        const word = /1↑/.test(said) ? 'miss' : 'hit'
        return [word, await readFile(path.join(pkg, 'dist', 'o'), 'utf8')]
      }
      const seen: Array<[string, string]> = [await step(), await step()]
      await write(path.join(pkg, 'src', 'main.ts'), 'modified')
      seen.push(await step())
      git(root, 'commit', '-q', '-am', 'edit')
      seen.push(await step())
      await write(path.join(pkg, 'src', 'b.ts'), '+new')
      seen.push(await step())
      expect(seen).toEqual([
        ['miss', 'initial'],
        ['hit', 'initial'],
        ['miss', 'modified'],
        ['hit', 'modified'],
        ['miss', '+newmodified'],
      ])
    },
    TIMEOUT,
  )
  it(
    'a run from a link to the workspace keys the same files as one from its real path',
    async () => {
      // Port of Turbo's scm test_symlinked_git_root: entered through a link,
      // the workspace's paths must still resolve inside git's top level.
      const real = path.join(root, 'real')
      const link = path.join(root, 'link')
      await write(path.join(real, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await writeLocalWorkspace(real)
      const pkg = path.join(real, 'packages', 'lib')
      await write(path.join(pkg, 'src', 'a'), '1')
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { name: 'lib', tasks: { build: {
           exec: { command: 'mkdir -p dist && cat src/a > dist/o' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(real, 'init', '-q')
      git(real, 'add', '-A')
      git(real, 'commit', '-q', '-m', 'init')
      await symlink(real, link)
      const seen: string[] = []
      for (const [cwd, v] of [
        [link, '1'],
        [link, '1'],
        [real, '1'],
        [link, '2'],
        [path.join(link, 'packages', 'lib'), '3'],
        [real, '3'],
      ] as const) {
        await write(path.join(pkg, 'src', 'a'), v)
        const word = /1↑/.test(vx(cwd, 'run', 'build', '--all')) ? 'miss' : 'hit'
        seen.push(`${word} ${await readFile(path.join(pkg, 'dist', 'o'), 'utf8')}`)
      }
      expect(seen).toEqual(['miss 1', 'hit 1', 'hit 1', 'miss 2', 'miss 3', 'hit 3'])
    },
    TIMEOUT,
  )
  it(
    'an edit inside a git worktree checked out under the inputs re-keys the task',
    async () => {
      // Port of Nx's git-worktrees nestedWorktreeRoots: git lists a nested
      // worktree as one untracked directory and never descends into it, so
      // its files must still reach the key through vx's own walk.
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await writeLocalWorkspace(root)
      const pkg = path.join(root, 'packages', 'lib')
      await write(path.join(pkg, 'src', 'a'), '1')
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { name: 'lib', tasks: { build: {
           exec: { command: 'mkdir -p dist && cat src/a src/wt/packages/lib/src/a > dist/o' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      git(root, 'worktree', 'add', '-q', path.join(pkg, 'src', 'wt'))
      const step = async (): Promise<string> => {
        const word = /1↑/.test(vx(root, 'run', 'build', '--all')) ? 'miss' : 'hit'
        return `${word} ${await readFile(path.join(pkg, 'dist', 'o'), 'utf8')}`
      }
      const seen = [await step(), await step()]
      await write(path.join(pkg, 'src', 'wt', 'packages', 'lib', 'src', 'a'), '2')
      seen.push(await step())
      expect(seen).toEqual(['miss 11', 'hit 11', 'miss 12'])
    },
    TIMEOUT,
  )
  // Every spelling git reads as false (A-33), the empty value and a zero
  // integer included.
  for (const off of ['false', 'no', 'off', '0', '', '00']) {
    it(
      `under core.fileMode=${off} an executable bit still re-keys the task`,
      async () => {
        // git reports no chmod then, so the file stays trusted at its index
        // mode, and the task replayed the output a plain input built (item
        // 1076). WSL's DrvFs writes this setting.
        await write(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'root', private: true }),
        )
        await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
        await writeLocalWorkspace(root)
        const pkg = path.join(root, 'packages', 'p')
        await write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
        await write(path.join(pkg, 'src', 'run.sh'), 'echo hi\n')
        await write(
          path.join(pkg, 'vx.config.mjs'),
          `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && (test -x src/run.sh && echo exec || echo plain) > dist/o' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
        )
        git(root, 'init', '-q')
        git(root, 'config', 'core.fileMode', off)
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'init')
        const out = path.join(pkg, 'dist', 'o')
        const step = async (): Promise<[string, string]> => {
          const said = vx(root, 'run', 'build', '--all')
          const word = /1↑/.test(said) ? 'miss' : 'hit'
          return [word, (await readFile(out, 'utf8')).trim()]
        }
        const seen: Array<[string, string]> = [await step()]
        await chmod(path.join(pkg, 'src', 'run.sh'), 0o755)
        seen.push(await step())
        // Control: back to the committed mode, back to the first entry.
        await chmod(path.join(pkg, 'src', 'run.sh'), 0o644)
        seen.push(await step())
        expect(seen).toEqual([
          ['miss', 'plain'],
          ['miss', 'exec'],
          ['hit', 'plain'],
        ])
      },
      TIMEOUT,
    )
  }
  it(
    'a round trip between two entries whose outputs carry one fixed mtime restores the right bytes',
    async () => {
      // A task that sets its outputs' mtime (`tar -x`, `cp -p`,
      // SOURCE_DATE_EPOCH; here `touch -t`) gives v1 and v2 identical
      // (size, mode, mtime) rows. Back on v1 with v2's bytes on disk, the
      // skip check matched v1's rows and reported up-to-date over v2's
      // bytes (item 886).
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeLocalWorkspace(root)
      const pkg = path.join(root, 'packages', 'p')
      await write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && cp src/v.txt dist/v.txt && touch -t 200109090146.40 dist/v.txt' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'init', '-q')
      const out = path.join(pkg, 'dist', 'v.txt')
      const seen: string[] = []
      for (const v of ['v1', 'v2', 'v1', 'v2', 'v2']) {
        await write(path.join(pkg, 'src', 'v.txt'), v)
        vx(root, 'run', 'build', '--all')
        seen.push(await readFile(out, 'utf8'))
      }
      expect(seen).toEqual(['v1', 'v2', 'v1', 'v2', 'v2'])
      // The steady state still skips: the last run found v2's own stamp.
      expect(vx(root, 'run', 'build', '--all')).toContain('1✓')
    },
    TIMEOUT,
  )
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
           inputs: { files: ['src/**'] },
           cache: {
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
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
      expect(out).not.toMatch(/ \d+✓/)
      expect(await Bun.file(path.join(root, 'dist', 'STRAY.txt')).exists()).toBe(false)
      expect(await readFile(path.join(root, 'dist', 'a.txt'), 'utf8')).toBe('a')
      expect(await readFile(path.join(root, 'dist', 'b.txt'), 'utf8')).toBe('b')
    },
    TIMEOUT,
  )
})
