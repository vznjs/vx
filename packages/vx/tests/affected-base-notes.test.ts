// `--affected` with no value in the two clone shapes CI produces, end to
// end through the CLI: a single-branch clone whose `origin/HEAD` is the
// branch under test (the base is HEAD itself, so nothing is ever affected
// — an exit-0 note was the only sign), and a depth-1 checkout with no
// `origin/HEAD` and no parent (no base at all; the old error named a
// `HEAD~1` nobody typed). Found by walking the CI persona, 2026-09-16.
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { edgesSource, PLUGIN_IMPORT, pluginSource, writeEdges } from './helpers/plugin.js'
import { noticed } from './helpers/notice.js'
import { git, gitInit } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

// A test spawns vx up to seven times: past bun's 5 s default on a loaded
// shard, bun killed the running vx and the next assertion read `exit 1: `.
setDefaultTimeout(30_000)

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args)

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-base-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeEdges(root)
  await mkdir(path.join(root, 'pkgs/app/src'), { recursive: true })
  await writeFile(path.join(root, 'pkgs/app/package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(
    path.join(root, 'pkgs/app/vx.config.mjs'),
    // `^build`: `--affected` reaches a dependent along a task edge.
    `export default { tasks: { build: { dependsOn: ['^build'], exec: { command: 'cat src/a.txt > out.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true } } }\n`,
  )
  await writeFile(path.join(root, 'pkgs/app/src/a.txt'), 'a1\n')
  await writeFile(path.join(root, '.gitignore'), 'out.txt\n.vx/cache/\n')
  gitInit(root, '-b', 'feat')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
})
/**
 * The fixture copied without its `.git`: removing a repository in place
 * left enough of it on macOS CI that `git init` found the old commit.
 */
async function withoutGit(): Promise<string> {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-nogit-'))
  await cp(root, copy, { recursive: true, filter: (src) => path.basename(src) !== '.git' })
  return copy
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('--affected with no value, in the clone shapes CI produces', () => {
  // Owner, 2026-10-17: on the base branch a bare --affected has no
  // default. `HEAD~1` saw one commit of a multi-commit push; what a push
  // changed is the last good commit's to say.
  it('on the base branch, a bare --affected is refused, naming the commit to pass', () => {
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat')
    const r = vx(root, 'run', 'build', '--affected')
    expect(r.code).not.toBe(0)
    expect(r.text).toContain(
      '--affected has no default on the base branch (feat): run --all (the cache skips what did not change), or name the last good commit, --affected=<sha>',
    )
  })

  // With --all already given, "run --all" was advice the user had followed.
  it('on the base branch, --affected beside --all says to drop --affected', () => {
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat')
    const r = vx(root, 'run', 'build', '--all', '--affected')
    expect(r.code).not.toBe(0)
    expect(r.text).toContain(
      '--affected has no default on the base branch (feat): drop --affected, --all runs every project (the cache skips what did not change), or name the last good commit, --affected=<sha>',
    )
  })

  it('an explicit base that is HEAD itself is named as such, with the two bases you probably meant', () => {
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    const r = vx(root, 'run', 'build', '--affected=origin/feat')
    expect(r.code).toBe(0)
    expect(r.text).toContain('nothing affected since origin/feat')
    expect(r.text).toContain(
      'origin/feat is HEAD itself: compare with the branch you merge into (--affected=origin/main) or the previous commit (--affected=HEAD~1)',
    )
  })

  // A fresh feature branch (`checkout -b feature origin/main`, or one
  // whose only edit is stashed) sits on its base without being it: the
  // note advised --affected=origin/main, the base already in use.
  it('a feature branch not yet past its base gets the plain note, no advice to use that base', async () => {
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'checkout', '-q', '-b', 'feature')
    const plain = noticed('vx run: nothing affected since origin/main', 'info').trimEnd()
    expect(vx(root, 'run', 'build', '--affected=origin/main').text.trim()).toBe(plain)
    await writeFile(path.join(root, 'pkgs/app/src/a.txt'), 'a2\n')
    git(root, 'stash', '-q')
    expect(vx(root, 'run', 'build', '--affected=origin/main').text.trim()).toBe(plain)
  })

  it('on the base branch itself, the note never suggests the base already in use', () => {
    git(root, 'checkout', '-q', '-b', 'main')
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const r = vx(root, 'run', 'build', '--affected=origin/main')
    expect(r.text.trim()).toBe(
      noticed(
        'vx run: nothing affected since origin/main — origin/main is HEAD itself: compare with the previous commit (--affected=HEAD~1)',
        'info',
      ).trimEnd(),
    )
  })

  // Turbo's CI spelling reads as its base, so the note had to read it so
  // too: `origin/feat...HEAD` said nothing of the base being HEAD.
  for (const ref of ['origin/feat...HEAD', 'origin/feat..HEAD']) {
    it(`a ${ref} whose base is HEAD itself is named as such`, () => {
      git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
      const r = vx(root, 'run', 'build', `--affected=${ref}`)
      expect(r.code).toBe(0)
      expect(r.text).toContain(`nothing affected since ${ref} — origin/feat is HEAD itself`)
    })
  }

  // Nx's `defaultBase` (`develop` in a git-flow repo) had nowhere to go: a
  // bare --affected compared with origin/HEAD and ran the wrong set.
  it('a bare --affected compares with baseBranch, from the file or a config stage; a value still wins', async () => {
    git(root, 'branch', 'develop')
    // Untracked, the file the row rewrites would itself be the change.
    await writeFile(path.join(root, '.gitignore'), 'out.txt\n.vx/cache/\n.vx/workspace.mjs\n')
    git(root, 'rm', '-q', '--cached', '.vx/workspace.mjs')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat')
    await writeFile(path.join(root, 'pkgs/app/src/a.txt'), 'a2\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    const plan = (...args: string[]) => {
      const r = vx(root, 'run', 'build', ...args, '--dry', '--format', 'json')
      if (r.code !== 0) return `exit ${r.code}: ${r.text}`
      const json = r.text.slice(r.text.indexOf('{'))
      return (JSON.parse(json) as { tasks: { id: string }[] }).tasks.map((t) => t.id)
    }
    const workspace = (body: string) =>
      Bun.write(path.join(root, '.vx/workspace.mjs'), `${PLUGIN_IMPORT}export default ${body}\n`)
    await workspace(`{ plugins: [${edgesSource()}] }`)
    expect(vx(root, 'run', 'build', '--affected').text).toContain(
      'no default on the base branch (feat)',
    )
    await workspace(`{ baseBranch: 'develop', plugins: [${edgesSource()}] }`)
    expect(plan('--affected')).toEqual(['app#build'])
    expect(vx(root, 'run', 'build', '--affected=HEAD').text).toContain(
      'nothing affected since HEAD',
    )
    await workspace(
      `{ plugins: [${edgesSource()}, ${pluginSource('base', `{ config(ws) { ws.baseBranch = 'develop' } }`)}] }`,
    )
    expect(plan('--affected')).toEqual(['app#build'])
  })

  it("VX_AFFECTED_BASE names a bare --affected's base, on the base branch too; it beats a plugin's base, a value beats it", async () => {
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat')
    await writeFile(path.join(root, '.gitignore'), 'out.txt\n.vx/cache/\n.vx/workspace.mjs\n')
    git(root, 'rm', '-q', '--cached', '.vx/workspace.mjs')
    await writeFile(path.join(root, 'pkgs/app/src/a.txt'), 'a2\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${edgesSource()}, ${pluginSource('org/ci', "{ config(_w, ctx) { ctx.setBranch({ base: 'HEAD' }) } }")}] }\n`,
    )
    const run = (env: Record<string, string>, ...args: string[]) => {
      const p = vxSync(root, ['run', 'build', ...args, '--dry', '--format', 'json'], { env })
      const out = p.out
      if (p.code !== 0) return `exit ${p.code}: ${out}${p.err}`
      return JSON.parse(out) as { affectedBase: string; tasks: { id: string }[] }
    }
    expect(run({}, '--affected')).toEqual({ affectedBase: 'HEAD', tasks: [] })
    expect(run({ VX_AFFECTED_BASE: 'HEAD~1' }, '--affected')).toMatchObject({
      affectedBase: 'HEAD~1',
      tasks: [{ id: 'app#build' }],
    })
    expect(run({ VX_AFFECTED_BASE: 'HEAD~1' }, '--affected=HEAD')).toEqual({
      affectedBase: 'HEAD',
      tasks: [],
    })
    // An empty one is unset, as Turbo reads an empty TURBO_SCM_BASE (#9053).
    expect(run({ VX_AFFECTED_BASE: '' }, '--affected')).toEqual({ affectedBase: 'HEAD', tasks: [] })
  })

  // A ref the variable gave was reported as if typed: nothing on the line
  // said where `origin/develop` came from.
  for (const base of ['origin/develop', 'nope..HEAD']) {
    it(`a VX_AFFECTED_BASE=${base} that does not resolve is named as the variable's`, () => {
      const p = vxSync(root, ['run', 'build', '--affected', '--dry'], {
        env: { VX_AFFECTED_BASE: base },
      })
      expect(p.code).toBe(1)
      const ref = base.split('..')[0]
      expect(p.err).toContain(`VX_AFFECTED_BASE=${base}: git ref "${ref}" did not resolve`)
    })
  }

  it('CONTROL: a real base that happens to select nothing keeps the plain note', async () => {
    await writeFile(path.join(root, 'README.md'), 'docs only\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'docs')
    const r = vx(root, 'run', 'build', '--affected=HEAD~1')
    expect(r.code).toBe(0)
    expect(r.text).toContain('nothing affected since HEAD~1')
    expect(r.text).not.toContain('HEAD itself')
  })

  // A script piping `--dry --format json` to jq broke exactly when there was
  // nothing to do: stdout was empty (Growth, affected-dry-json-empty.sh).
  it('--dry --format json with nothing to run still prints a plan, the note on stderr', async () => {
    const dry = (...args: string[]) => {
      const p = vxSync(root, ['run', 'build', ...args, '--dry', '--format', 'json'])
      return { code: p.code, stdout: p.out, stderr: p.err }
    }
    await writeFile(path.join(root, 'README.md'), 'docs only\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'docs')
    const none = dry('--affected=HEAD~1')
    expect(none.code).toBe(0)
    expect(JSON.parse(none.stdout)).toEqual({ affectedBase: 'HEAD~1', tasks: [] })
    expect(none.stderr).toContain('nothing affected since HEAD~1')
    // An affected project that declares no such task.
    await mkdir(path.join(root, 'pkgs/docs'), { recursive: true })
    await writeFile(path.join(root, 'pkgs/docs/package.json'), JSON.stringify({ name: 'docs' }))
    await writeFile(
      path.join(root, 'pkgs/docs/vx.config.mjs'),
      `export default { tasks: { lint: { exec: { command: 'true' } } } }\n`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'docs project')
    const undeclared = dry('--affected=HEAD~1')
    expect(undeclared.code).toBe(0)
    expect(JSON.parse(undeclared.stdout)).toEqual({ affectedBase: 'HEAD~1', tasks: [] })
    expect(undeclared.stderr).toContain('the change reaches no build task')
  })

  // nx#33330: an explicit base still probed the default branch first, and
  // a clone without one printed git's `fatal:` before the run.
  it('an explicit base never asks git for origin/HEAD or main, and no git error is printed', async () => {
    const first = Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: root })
      .stdout.toString()
      .trim()
    await writeFile(path.join(root, 'pkgs/app/src/a.txt'), 'a2\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    const shimDir = await mkdtemp(path.join(os.tmpdir(), 'vx-git-shim-'))
    try {
      const log = path.join(shimDir, 'calls.log')
      await writeFile(
        path.join(shimDir, 'git'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${Bun.which('git')}' "$@"\n`,
        { mode: 0o755 },
      )
      const p = vxSync(root, ['run', 'build', `--affected=${first}`, '--dry', '--format', 'json'], {
        env: { PATH: `${shimDir}:${process.env['PATH']}` },
      })
      expect({ code: p.code, stderr: p.err }).toEqual({ code: 0, stderr: '' })
      const tasks = (JSON.parse(p.out) as { tasks: { id: string }[] }).tasks
      expect(tasks.map((t) => t.id)).toEqual(['app#build'])
      const calls = (await Bun.file(log).text()).trim().split('\n')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.some((c) => c.includes(first))).toBe(true)
      expect(calls.filter((c) => /\b(origin\/HEAD|origin\/main|main|master)\b/.test(c))).toEqual([])
    } finally {
      await rm(shimDir, { recursive: true, force: true })
    }
  })

  // turborepo#4559, #9208: in a shallow clone the base's parent is not
  // there, and the affected walk failed on the missing object.
  it('in a real depth-2 clone, --affected=HEAD~1 and ...[HEAD^] select the change and its dependents', async () => {
    await mkdir(path.join(root, 'pkgs/lib/src'), { recursive: true })
    await writeFile(path.join(root, 'pkgs/lib/package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(
      path.join(root, 'pkgs/lib/vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l1\n')
    await writeEdges(root, { app: ['lib'] })
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l2\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'three')

    const parent = await mkdtemp(path.join(os.tmpdir(), 'vx-shallow-'))
    try {
      const clone = path.join(parent, 'clone')
      git(parent, 'clone', '-q', '--depth', '2', `file://${root}`, clone)
      const shallow = Bun.spawnSync({
        cmd: ['git', 'rev-parse', '--is-shallow-repository'],
        cwd: clone,
      })
      expect(shallow.stdout.toString().trim()).toBe('true')
      const plan = (args: string[], cwd = clone) => {
        const p = vxSync(cwd, ['run', 'build', ...args, '--dry', '--format', 'json'])
        if (p.code !== 0) return `exit ${p.code}: ${p.err}`
        return (JSON.parse(p.out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
      }
      expect(plan(['--affected=HEAD~1'])).toEqual(['app#build', 'lib#build'])
      expect(plan(['--filter', '...[HEAD^]'])).toEqual(['app#build', 'lib#build'])
      // A depth-1 clone (CI's default checkout) fetches the parent it lacks.
      const one = path.join(parent, 'one')
      git(parent, 'clone', '-q', '--depth', '1', `file://${root}`, one)
      expect(plan(['--affected=HEAD~1'], one)).toEqual(['app#build', 'lib#build'])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('a `!` exclude removes a project from --affected, whichever side of it it sits (item 955)', async () => {
    // `--affected` is `...[<base>]`, and it was appended AFTER every
    // `--filter`, so an exclude applied in argv order before it and removed
    // nothing: `--affected --filter '!app'` still ran app.
    await mkdir(path.join(root, 'pkgs/lib/src'), { recursive: true })
    await writeFile(path.join(root, 'pkgs/lib/package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(
      path.join(root, 'pkgs/lib/vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l1\n')
    await writeEdges(root, { app: ['lib'] })
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l2\n')
    const plan = (...args: string[]) => {
      const p = vxSync(root, ['run', 'build', ...args, '--dry', '--format', 'json'])
      if (p.code !== 0) return `exit ${p.code}: ${p.err}`
      return (JSON.parse(p.out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
    }
    // Control: the change and its dependent.
    expect(plan('--affected=HEAD')).toEqual(['app#build', 'lib#build'])
    expect(plan('--affected=HEAD', '--filter', '!app')).toEqual(['lib#build'])
    expect(plan('--filter', '!app', '--affected=HEAD')).toEqual(['lib#build'])
  })

  it('a `--filter` beside --affected adds its projects, as every include does (X-10)', async () => {
    // The union of projects was taken, then the run kept only the tasks
    // the diff reached, so `--filter other` was dropped with exit 0.
    for (const name of ['lib', 'other']) {
      await mkdir(path.join(root, `pkgs/${name}/src`), { recursive: true })
      await writeFile(path.join(root, `pkgs/${name}/package.json`), JSON.stringify({ name }))
      // Inputs: a task with none is affected by any change.
      await writeFile(
        path.join(root, `pkgs/${name}/vx.config.mjs`),
        `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] } } } }\n`,
      )
      await writeFile(path.join(root, `pkgs/${name}/src/l.txt`), 'l1\n')
    }
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l2\n')
    const plan = (...args: string[]) => {
      const p = vxSync(root, ['run', 'build', ...args, '--dry', '--format', 'json'])
      if (p.code !== 0) return `exit ${p.code}: ${p.err}`
      return (JSON.parse(p.out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
    }
    expect(plan('--affected=HEAD')).toEqual(['lib#build'])
    expect(plan('--affected=HEAD', '--filter', 'other')).toEqual(['lib#build', 'other#build'])
    // An exclude still wins over the include it overlaps.
    expect(plan('--affected=HEAD', '--filter', 'other', '--filter', '!other')).toEqual([
      'lib#build',
    ])
  })

  it('a diff that matched, then lost every project to an exclusion or a walk, says which (X-146)', async () => {
    // The HEAD note fired whenever every include was a diff, so a change
    // an exclusion took back read as "nothing changed — HEAD is HEAD".
    await mkdir(path.join(root, 'pkgs/lib/src'), { recursive: true })
    await writeFile(path.join(root, 'pkgs/lib/package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(
      path.join(root, 'pkgs/lib/vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l1\n')
    await writeEdges(root, { app: ['lib'] })
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'two')
    const note = (...args: string[]) => {
      const r = vx(root, 'run', 'build', ...args)
      return { exitCode: r.code, out: r.text.trim() }
    }
    const head = noticed(
      'vx run: nothing affected since HEAD — the working tree has no change against HEAD; to compare commits, use the branch you merge into (--affected=origin/main) or the previous commit (--affected=HEAD~1)',
      'info',
    ).trimEnd()
    const cases = [
      ['--filter', '[HEAD]', '--filter', '!lib'],
      ['--filter', '[HEAD]^...'],
      ['--affected=HEAD', '--filter', '!lib', '--filter', '!app'],
    ]
    // CONTROL: an empty diff keeps the HEAD note, whatever else is asked.
    expect(cases.map((c) => note(...c))).toEqual(cases.map(() => ({ exitCode: 0, out: head })))
    await writeFile(path.join(root, 'pkgs/lib/src/l.txt'), 'l2\n')
    // Still exit 0: an exclusion that leaves nothing is no CI failure.
    expect(cases.map((c) => note(...c))).toEqual([
      {
        exitCode: 0,
        out: noticed(
          'vx run: no projects selected: !lib excluded every project the other filters matched',
          'info',
        ).trimEnd(),
      },
      {
        exitCode: 0,
        out: noticed(
          'vx run: no projects selected: filter "[HEAD]^..." matched lib, which depends on no project',
          'info',
        ).trimEnd(),
      },
      {
        exitCode: 0,
        out: noticed(
          'vx run: no projects selected: !lib, !app excluded every project the other filters matched',
          'info',
        ).trimEnd(),
      },
    ])
  }, 30_000)

  it('an edit no project holds keeps "nothing affected", without "no change against HEAD"', async () => {
    // The note claimed a clean tree whenever no project was selected, though
    // a tracked root file no task declares had been edited.
    await writeFile(path.join(root, 'README.md'), 'r1\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'readme')
    await writeFile(path.join(root, 'README.md'), 'r2\n')
    // A typed `[HEAD]` filter is the same question: its diff, too, named
    // the edit, and the note still claimed a clean tree.
    for (const args of [['--affected=HEAD'], ['--filter', '[HEAD]'], ['--filter', 'app[HEAD]']]) {
      const r = vx(root, 'run', 'build', ...args)
      // `--affected` asks the tasks; a project filter, the projects.
      expect({ args, exitCode: r.code, out: r.text.trim() }).toEqual({
        args,
        exitCode: 0,
        out:
          args[0] === '--affected=HEAD'
            ? 'Nothing affected: the change reaches no build task.'
            : noticed('vx run: nothing affected since HEAD', 'info').trimEnd(),
      })
    }
  })

  it('no origin/HEAD and no parent commit: no base at all, exit 1', () => {
    const r = vx(root, 'run', 'build', '--affected')
    expect(r.code).toBe(1)
    expect(r.text).toContain('--affected has no base here')
    expect(r.text).toContain('set `baseBranch`, or name the base: --affected=origin/main')
    expect(r.text).not.toContain('did not resolve')
  })

  it('outside a git work tree every base form says so, as a plain run does (X-52)', async () => {
    const root = await withoutGit()
    // vx names the canonical root: macOS's /tmp is a link to /private/tmp.
    const real = await realpath(root)
    const refusal = noticed(
      `vx run: vx requires git: ${real} is not inside a git work tree. Run 'git init' in your workspace root.`,
    ).trimEnd()
    // A sandboxed CI shard's temp dir sits under a repository git found by
    // walking up; the ceiling keeps the fixture its own world.
    process.env['GIT_CEILING_DIRECTORIES'] = `${path.dirname(root)}:${path.dirname(real)}`
    try {
      for (const args of [['--affected'], ['--affected=main'], ['--filter', '...[main]']]) {
        const r = vx(root, 'run', 'build', ...args)
        expect({ args, exitCode: r.code, first: r.text.split('\n  (git: ')[0] }).toEqual({
          args,
          exitCode: 1,
          first: refusal,
        })
      }
    } finally {
      delete process.env['GIT_CEILING_DIRECTORIES']
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a repository with no commit yet says that, not "no base branch" (X-52)', async () => {
    const root = await withoutGit()
    try {
      git(root, 'init', '-q', '-b', 'feat')
      const r = vx(root, 'run', 'build', '--affected')
      expect({ exitCode: r.code, out: r.text.trim() }).toEqual({
        exitCode: 1,
        out: noticed(
          'vx run: --affected has no base here: this repository has no commit yet. Commit first, or run without --affected.',
        ).trimEnd(),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
