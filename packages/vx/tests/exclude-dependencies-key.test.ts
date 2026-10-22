// Stale-cache-hit regressions for --exclude-dependencies, split from
// stale-hit-git.test.ts so no file holds a shard alone (2026-10-22).
// The same shape: the real CLI against a real git-backed fixture.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { edgesSource, writeEdges } from './helpers/plugin.js'

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

// nx#35234: `--exclude-dependencies` drops an edge from the SCHEDULE. It
// dropped it from the key too, so `app#build` keyed on nothing of `lib`: a
// miss for no reason, then, once `lib` changed, a hit that replayed the old
// `lib`. The fixture is the survey's: `lib#build` copies its source into
// `dist/`, `app#build` (`dependsOn: ['^build']`) copies that.
describe('--exclude-dependencies keys on the dependency it skips', () => {
  async function libApp(): Promise<{ lib: string; app: string }> {
    await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
    await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeEdges(root, { app: ['lib'] })
    const lib = path.join(root, 'packages', 'lib')
    const app = path.join(root, 'packages', 'app')
    await write(path.join(lib, 'package.json'), '{"name":"lib","version":"1.0.0"}')
    await write(path.join(app, 'package.json'), '{"name":"app","version":"1.0.0"}')
    await write(
      path.join(lib, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: 'mkdir -p dist && cat src/x.txt > dist/lib.txt' },
         inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
       } } }\n`,
    )
    await write(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: { build: {
         dependsOn: ['^build'],
         exec: { command: 'mkdir -p dist && cat ../lib/dist/lib.txt > dist/app.txt' },
         inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
       } } }\n`,
    )
    await write(path.join(lib, 'src', 'x.txt'), 'L1')
    await write(path.join(app, 'src', 'a.txt'), 'a')
    await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    return { lib, app }
  }

  // `base` <- `lib` <- `app`, each `build` on `^build`.
  async function baseLibApp(): Promise<{ base: string; lib: string; app: string }> {
    const { lib, app } = await libApp()
    const base = path.join(root, 'packages', 'base')
    await write(path.join(base, 'package.json'), '{"name":"base","version":"1.0.0"}')
    await write(
      path.join(base, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: 'mkdir -p dist && cat src/b.txt > dist/b.txt' },
         inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
       } } }\n`,
    )
    await write(path.join(base, 'src', 'b.txt'), 'b')
    await writeEdges(root, { app: ['lib'], lib: ['base'] })
    await write(
      path.join(lib, 'vx.config.mjs'),
      `export default { tasks: { build: {
         dependsOn: ['^build'],
         exec: { command: 'mkdir -p dist && cat src/x.txt > dist/lib.txt' },
         inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
       } } }\n`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
    return { base, lib, app }
  }

  const appHash = (...flags: string[]): string => {
    const plan = JSON.parse(vx(root, 'run', 'app#build', '--dry=json', ...flags)) as {
      tasks: Array<{ id: string; hash: string }>
    }
    return plan.tasks.find((t) => t.id === 'app#build')!.hash
  }

  it(
    'the dependant has one key with and without the flag, and it hits',
    async () => {
      await libApp()
      vx(root, 'run', 'build', '--all')
      const full = appHash()
      expect([appHash('--exclude-dependencies'), appHash('--exclude-dependencies=build')]).toEqual([
        full,
        full,
      ])
      expect(vx(root, 'run', 'app#build', '--exclude-dependencies')).toMatch(/ \d+✓/)
    },
    TIMEOUT,
  )

  it(
    'a change to the skipped dependency is a miss, not the old bytes',
    async () => {
      const { lib, app } = await libApp()
      vx(root, 'run', 'build', '--all')
      vx(root, 'run', 'app#build', '--exclude-dependencies')
      await write(path.join(lib, 'src', 'x.txt'), 'L2')
      vx(root, 'run', 'lib#build')
      vx(root, 'run', 'app#build', '--exclude-dependencies')
      expect(await readFile(path.join(app, 'dist', 'app.txt'), 'utf8')).toBe('L2')
    },
    TIMEOUT,
  )

  // The up-front classify hands a STABLE task its key, so the rows above
  // never reach the key the run derives lazily. A same-project producer
  // (`prep`, scheduled: only `build` edges are dropped) makes `app#build`'s
  // key wait for it, and that lazy key must fold the skipped `lib` too.
  it(
    'a dependant keyed after its producer runs folds the skipped key too',
    async () => {
      const { app } = await libApp()
      await write(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
           prep: {
             exec: { command: 'mkdir -p gen && cat src/a.txt > gen/a.txt' },
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['gen/**'] } },
           },
           build: {
             dependsOn: ['^build', 'prep'],
             exec: { command: 'mkdir -p dist && cat ../lib/dist/lib.txt gen/a.txt > dist/app.txt' },
             inputs: { files: ['src/**', 'gen/**'], tasks: ['^build'] }, cache: { outputs: { files: ['dist/**'] } },
           },
         } }\n`,
      )
      await write(path.join(root, '.gitignore'), 'dist/\ngen/\n.vx/cache/\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'prep')
      await writeLocalWorkspace(root, [edgesSource({ app: ['lib'] })])
      vx(root, 'run', 'build', '--all')
      const out = vx(root, 'run', 'app#build', '--exclude-dependencies=build', '--output-logs=none')
      // `prep` and `app#build` both current: the run's key is the full one.
      expect(out).toContain('2✓')
    },
    TIMEOUT,
  )

  // Both requested, both losing an edge: `lib#build`'s key, as `app#build`
  // folds it, is derived without running it and must still fold `base`.
  it(
    'a skipped dependency that is itself requested is keyed on what IT skipped',
    async () => {
      await baseLibApp()
      vx(root, 'run', 'build', '--all')
      const out = vx(root, 'run', 'app#build', 'lib#build', '--exclude-dependencies')
      expect(out).toContain('2✓')
    },
    TIMEOUT,
  )

  it(
    'a task reached through a skipped one runs first, and folds into no key twice (item 1019)',
    async () => {
      // app → lib → base with `lib#build` skipped and `base#build` asked
      // for: app ran beside base. The edge that orders them is not a key
      // edge; app's key is the full run's, which folds base through lib.
      await baseLibApp()
      const full = appHash()
      const plan = JSON.parse(
        vx(root, 'run', 'app#build', 'base#build', '--dry=json', '--exclude-dependencies=build'),
      ) as { tasks: Array<{ id: string; hash: string; deps: string[] }> }
      const app = plan.tasks.find((t) => t.id === 'app#build')!
      expect({ deps: app.deps, hash: app.hash }).toEqual({ deps: ['base#build'], hash: full })
    },
    TIMEOUT,
  )

  it(
    'a skipped task whose dependency orders past another skipped one keys as the full run (item 1019)',
    async () => {
      // app#build → app#gen → lib#build → lib#gen → base#build, `gen`
      // skipped: lib#build orders after base#build, and app#gen's derived
      // key folds lib#build's, which must not fold base#build twice.
      await baseLibApp()
      for (const [dir, dep] of [
        ['app', "'^build'"],
        ['lib', "'^build'"],
      ] as const) {
        await write(
          path.join(root, 'packages', dir, 'vx.config.mjs'),
          `export default { tasks: {
             gen: { dependsOn: [${dep}], exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
             build: {
               dependsOn: ['gen'],
               exec: { command: 'mkdir -p dist && cp src/* dist/' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           } }\n`,
        )
      }
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'gen')
      const full = appHash()
      const plan = JSON.parse(
        vx(root, 'run', 'build', '--all', '--dry=json', '--exclude-dependencies=gen'),
      ) as { tasks: Array<{ id: string; hash: string; deps: string[] }> }
      const byId = new Map(plan.tasks.map((t) => [t.id, t]))
      expect({
        app: byId.get('app#build')!.hash,
        libDeps: byId.get('lib#build')!.deps,
      }).toEqual({ app: full, libDeps: ['base#build'] })
    },
    TIMEOUT,
  )

  // The four rows below were each open to a single mutation of
  // excluded-keys.ts (item 766): the key a dropped dependency folds must be
  // the one the live path gives it, whatever its shape.
  const withLibConfig = async (config: string): Promise<void> => {
    await libApp()
    await write(path.join(root, 'packages', 'lib', 'vx.config.mjs'), config)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'lib shape')
  }

  it(
    'a skipped dependency that is a GROUP folds as a group, as the full run does',
    async () => {
      await withLibConfig(
        `export default { tasks: {
           compile: {
             exec: { command: 'mkdir -p dist && cat src/x.txt > dist/lib.txt' },
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
           },
           build: { dependsOn: ['compile'] },
         } }\n`,
      )
      expect(appHash('--exclude-dependencies')).toBe(appHash())
    },
    TIMEOUT,
  )

  it(
    'a skipped dependency that is PERSISTENT folds no key, as the full run does',
    async () => {
      await withLibConfig(
        `export default { tasks: { build: {
           exec: { command: 'echo ready && exec sleep 30', persistent: { readyWhen: 'ready' } },
           inputs: { files: ['src/**'] },
         } } }\n`,
      )
      expect(appHash('--exclude-dependencies')).toBe(appHash())
    },
    TIMEOUT,
  )

  it(
    '`--dry` calls a dependant of a persistent task by the key the run uses',
    async () => {
      // The plan keyed the persistent `lib#build` and folded that into
      // `app#build`'s key, which the run never derives: after a run saved
      // `app#build`, `--dry` still said "cache miss — would exec" (item 766).
      await withLibConfig(
        `export default { tasks: { build: {
           exec: { command: 'echo ready && exec sleep 30', persistent: { readyWhen: 'ready' } },
           inputs: { files: ['src/**'] },
         } } }\n`,
      )
      await write(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        `export default { tasks: { build: {
           dependsOn: ['^build'],
           exec: { command: 'mkdir -p dist && cat src/a.txt > dist/app.txt' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'app reads its own source')
      expect(vx(root, 'run', 'app#build')).toContain('1↑')
      const plan = JSON.parse(vx(root, 'run', 'app#build', '--dry=json')) as {
        tasks: Array<{ id: string; hash: string; cacheStatus: string }>
      }
      expect(plan.tasks.map((t) => [t.id, t.cacheStatus])).toEqual([
        ['app#build', 'hit-local'],
        // Its one dependant restores, so the run never spawns it (WD-17).
        ['lib#build', 'not-started'],
      ])
    },
    TIMEOUT,
  )

  it(
    "a cached dependant of a persistent task re-runs when the server's sources change",
    async () => {
      // The persistent `lib#build` had no key, so `app#build` folded nothing
      // of it: a cached e2e behind a dev server replayed after the server
      // changed (A-17). It is keyed now on its inputs; with none, its
      // dependant never hits.
      await withLibConfig(
        `export default { tasks: { build: {
           exec: { command: 'echo ready && exec sleep 30', persistent: { readyWhen: 'ready' } },
           inputs: { files: ['src/**'] },
         } } }\n`,
      )
      await write(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        `export default { tasks: { build: {
           dependsOn: ['^build'],
           exec: { command: 'mkdir -p dist && cat src/a.txt > dist/app.txt' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'app behind a server')
      expect(vx(root, 'run', 'app#build')).toContain('1↑')
      expect(vx(root, 'run', 'app#build')).toContain('1✓')
      await write(path.join(root, 'packages', 'lib', 'src', 'x.txt'), 'server v2')
      expect(vx(root, 'run', 'app#build')).toContain('1↑')
    },
    TIMEOUT,
  )

  it(
    'a skipped dependency with a project nested inside it keeps that project out of its key',
    async () => {
      await withLibConfig(
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && cat src/x.txt > dist/lib.txt' },
           inputs: { files: ['**/*'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      const inner = path.join(root, 'packages', 'lib', 'inner')
      await write(path.join(inner, 'package.json'), '{"name":"inner","version":"1.0.0"}')
      // Config-bearing: a package with no config and no \`project\` plugin
      // is only a directory of its parent (prepare.ts), fenced by nothing.
      await write(path.join(inner, 'vx.config.mjs'), 'export default { tasks: {} }\n')
      await write(path.join(inner, 'src', 'i.txt'), 'i')
      await write(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "packages/lib/inner"\n',
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'nested')
      const full = appHash()
      expect(appHash('--exclude-dependencies')).toBe(full)
      await write(path.join(inner, 'src', 'i.txt'), 'i2')
      expect(appHash('--exclude-dependencies')).toBe(full)
    },
    TIMEOUT,
  )

  // A requested dependency keeps its edge (item 980), so the requested task
  // the derivation keys is one BELOW a skipped one: `base#build` under the
  // skipped `lib#build`. A requested task folds what `--` forwards.
  it(
    'a requested task beneath a skipped one folds the forwarded arguments, as the full run does',
    async () => {
      await baseLibApp()
      const hashOf = (...flags: string[]): string => {
        const plan = JSON.parse(
          vx(root, 'run', 'app#build', 'base#build', '--dry=json', ...flags),
        ) as { tasks: Array<{ id: string; hash: string }> }
        return plan.tasks.find((t) => t.id === 'app#build')!.hash
      }
      const forwarded = ['--', '--mode=ci']
      const full = hashOf(...forwarded)
      expect([hashOf('--exclude-dependencies=build', ...forwarded), full === hashOf()]).toEqual([
        full,
        false,
      ])
    },
    TIMEOUT,
  )

  // Two scheduled tasks each lose an edge, one of them two: every dropped
  // task is keyed, not the first task's nor the first of a task's list.
  it(
    'every skipped dependency of every dependant is keyed, as the full run does',
    async () => {
      await baseLibApp()
      await writeEdges(root, { app: ['lib', 'base'], top: ['tool'] })
      const tool = path.join(root, 'packages', 'tool')
      const top = path.join(root, 'packages', 'top')
      await write(path.join(tool, 'package.json'), '{"name":"tool","version":"1.0.0"}')
      await write(
        path.join(tool, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'true' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
         } } }\n`,
      )
      await write(path.join(tool, 'src', 't.txt'), 't')
      await write(path.join(top, 'package.json'), '{"name":"top","version":"1.0.0"}')
      await write(
        path.join(top, 'vx.config.mjs'),
        `export default { tasks: { build: {
           dependsOn: ['^build'],
           exec: { command: 'true' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
         } } }\n`,
      )
      await write(path.join(top, 'src', 't.txt'), 't')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'two dependants')
      const hashes = (...flags: string[]): string[] => {
        const plan = JSON.parse(
          vx(root, 'run', 'app#build', 'top#build', '--dry=json', ...flags),
        ) as { tasks: Array<{ id: string; hash: string }> }
        return ['app#build', 'top#build'].map((id) => plan.tasks.find((t) => t.id === id)!.hash)
      }
      expect(hashes('--exclude-dependencies')).toEqual(hashes())
    },
    TIMEOUT,
  )

  // `--continue=always` taints a task behind a failed upstream, and the
  // skipped dependency reaches the task as a synthetic outcome: one that
  // reads as failed would withhold the save of a task that folds nothing.
  it(
    'under --continue=always a task that folds no skipped key still saves',
    async () => {
      const { app } = await libApp()
      await write(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: { build: {
           dependsOn: ['^build'],
           exec: { command: 'mkdir -p dist && cat src/a.txt > dist/app.txt' },
           inputs: { files: ['src/**'], tasks: [] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'app folds no task')
      const out = vx(root, 'run', 'app#build', '--exclude-dependencies', '--continue=always')
      expect([out.includes('1↑'), vx(root, 'run', 'app#build').includes('1✓')]).toEqual([
        true,
        true,
      ])
    },
    TIMEOUT,
  )

  // Only `app#build` is scheduled, so `lib#build` and `base#build` are both
  // keyed without running; `lib`'s key must fold `base`'s, which therefore
  // has to exist first.
  it(
    'a dependency two hops below the skipped one reaches the key through it',
    async () => {
      const { base } = await baseLibApp()
      vx(root, 'run', 'build', '--all')
      const before = appHash('--exclude-dependencies')
      await write(path.join(base, 'src', 'b.txt'), 'b2')
      const after = [appHash(), appHash('--exclude-dependencies')]
      expect([after[0] === after[1], after[1] === before]).toEqual([true, false])
    },
    TIMEOUT,
  )

  // Folding the key is half the fix. The skipped dependency did not run, so
  // its outputs may predate its inputs; an entry saved then would file the
  // OLD `lib` under the key the next full run derives for the NEW one.
  it(
    'what a run builds on a skipped, out-of-date dependency is not saved',
    async () => {
      const { lib, app } = await libApp()
      vx(root, 'run', 'build', '--all')
      await write(path.join(lib, 'src', 'x.txt'), 'L2')
      const out = vx(root, 'run', 'app#build', '--exclude-dependencies')
      expect(out).toContain('1 cached task(s) build on a skipped dependency')
      expect(await readFile(path.join(app, 'dist', 'app.txt'), 'utf8')).toBe('L1')
      vx(root, 'run', 'app#build')
      expect(await readFile(path.join(app, 'dist', 'app.txt'), 'utf8')).toBe('L2')
    },
    TIMEOUT,
  )

  // The line counts what would have saved. A task with no `cache` saves
  // nothing whatever it folds, so skipping its dependency says nothing.
  it(
    'a skipped dependency under an uncached task makes no line',
    async () => {
      const { app } = await libApp()
      await write(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
         build: {
           dependsOn: ['^build'],
           exec: { command: 'mkdir -p dist && cat ../lib/dist/lib.txt > dist/app.txt' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         },
         check: { dependsOn: ['^build'], exec: { command: 'true' } },
       } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'check')
      vx(root, 'run', 'build', '--all')
      const lines = (out: string): string[] =>
        out.split('\n').filter((l) => l.startsWith('[vx] --exclude-dependencies'))
      expect(lines(vx(root, 'run', 'app#check', '--exclude-dependencies'))).toEqual([])
      // CONTROL: the cached sibling, the same edge dropped, is counted.
      expect(lines(vx(root, 'run', 'app#build', 'app#check', '--exclude-dependencies'))).toEqual([
        '[vx] --exclude-dependencies: 1 cached task(s) build on a skipped dependency; what they build is not saved',
      ])
    },
    TIMEOUT,
  )

  // A group folds every dependency it has, so a group that lost one hands
  // the skipped key, and the taint, to whatever folds the group.
  it(
    'what folds a group that skipped a dependency is not saved either',
    async () => {
      const { lib, app } = await libApp()
      await write(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
         deps: { dependsOn: ['^build'] },
         build: {
           dependsOn: ['deps'],
           exec: { command: 'mkdir -p dist && cat ../lib/dist/lib.txt > dist/app.txt' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         },
       } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'group')
      vx(root, 'run', 'build', '--all')
      await write(path.join(lib, 'src', 'x.txt'), 'L2')
      // The group is the seed; the line counts the cached task it reaches.
      expect(vx(root, 'run', 'app#build', '--exclude-dependencies=build')).toContain(
        '1 cached task(s) build on a skipped dependency',
      )
      expect(await readFile(path.join(app, 'dist', 'app.txt'), 'utf8')).toBe('L1')
      vx(root, 'run', 'app#build')
      expect(await readFile(path.join(app, 'dist', 'app.txt'), 'utf8')).toBe('L2')
    },
    TIMEOUT,
  )
})
