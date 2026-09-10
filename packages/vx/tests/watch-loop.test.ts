// The watch loop end to end, on markers rather than sleeps: "watching"
// on stdout means every watcher has proved delivery, and an execution
// count kept OUTSIDE the workspace says how many times the task's command
// actually ran (a cache hit runs nothing). The three claims the 2026-07
// parity doc left unpinned (M8, L5, and M7's documented converse): an
// edit re-runs exactly once; a same-content rewrite re-executes nothing;
// a `git checkout` that rewrites many inputs at once is one cycle.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SETTLE_MS = 1_000

interface Watch {
  proc: ReturnType<typeof Bun.spawn>
  out: () => string
  cycles: () => number
}

async function until(
  cond: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function executions(log: string): Promise<number> {
  const f = Bun.file(log)
  if (!(await f.exists())) return 0
  return (await f.text()).split('\n').filter((l) => l === 'run').length
}

function startWatch(root: string, select: readonly string[] = ['--all']): Watch {
  const proc = Bun.spawn([process.execPath, BIN, 'watch', 'build', ...select], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, VX_KILL_GRACE_MS: '200' },
  })
  let out = ''
  void (async () => {
    for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
  })()
  return {
    proc,
    out: () => out,
    cycles: () => out.split('re-running...').length - 1,
  }
}

describe('vx watch loop (e2e)', () => {
  let root: string
  let outside: string
  let log: string
  let dir: string
  let watch: Watch | undefined
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-loop-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
    log = path.join(outside, 'runs.log')
    dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    )
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
  })
  afterEach(async () => {
    if (watch !== undefined) {
      watch.proc.kill('SIGTERM')
      await watch.proc.exited
      watch = undefined
    }
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('an edit re-runs once; the same bytes again re-execute nothing; a new edit re-runs', async () => {
    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(log)).toBe(1)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(log)) === 2, 'the re-run after an edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')

    // M8: the same bytes written again are not a change — no cycle at
    // all, so no execution. Without the content gate the loop re-ran
    // (a cache hit, but a cycle) on every such write.
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await executions(log)).toBe(2)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a3\n')
    await until(async () => (await executions(log)) === 3, 'the re-run after a second edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(2)
  }, 40_000)

  it('an edit to vx.workspace.mjs is one cycle that runs under the new workspace config', async () => {
    // The workspace config is no task's input, so no project arm sees it;
    // its plugins, `config` stage and concurrency shape every cycle all the
    // same. Before 2026-09-10 the root arm listened for fingerprint files
    // only, and a plugin added under `vx watch` waited for a restart.
    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(log)).toBe(1)

    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
        'org/greeter',
        `{ config(_ws, ctx) { ctx.warn('WS-EDIT-SEEN') } }`,
      )}] }\n`,
    )
    await until(
      () => w.out().includes('WS-EDIT-SEEN'),
      'the cycle under the edited workspace config',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    // The config is not key material: the task is a hit under it.
    expect(await executions(log)).toBe(1)
  }, 40_000)

  it('a package added under a running watch is a cycle that runs it, and its edits are cycles from then on', async () => {
    // Its directory appears as one entry under `packages/` — the glob's
    // directory, watched non-recursively — and the cycle that follows
    // re-reads the workspace and arms the new dir. Before 2026-09-10 the
    // watched set was fixed when the loop armed: nothing ran until some
    // other edit, and every edit inside the new package was silence.
    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(log)).toBe(1)

    const bDir = await addProject(
      root,
      'b',
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    )
    await mkdir(path.join(bDir, 'src'), { recursive: true })
    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b1\n')
    await until(async () => (await executions(log)) === 2, 'the cycle after the package was added')
    await until(() => w.out().includes('vx watch: watching 2 project(s)'), 'the re-armed set')
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b1\n')

    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b2\n')
    await until(
      async () => (await executions(log)) === 3,
      'the cycle after an edit in the new package',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b2\n')
  }, 40_000)

  it('under the root watcher, a root file no key can see is not a cycle; a declared one is', async () => {
    // A `workspaceFiles` input puts the loop on ONE recursive root watcher.
    // Before the filter, that watcher triggered on every write in the tree:
    // `vx watch … > build.log` inside the repo never settled (each cycle
    // grew the log, the log was an event, the event was a cycle), and a
    // coverage run at the root cost a cycle per file. Differential: with the
    // filter removed from the arm, the `build.log` write below is a cycle.
    await writeFile(path.join(root, 'tsconfig.base.json'), '{"a":1}\n')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
            cache: { inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    watch = startWatch(root)
    const w = watch
    await until(
      () => w.out().includes('vx watch: watching the workspace root'),
      'the root-watcher marker',
    )
    expect(await executions(log)).toBe(1)

    await writeFile(path.join(root, 'build.log'), 'vx watch: initial run...\n')
    await mkdir(path.join(root, 'coverage'), { recursive: true })
    await writeFile(path.join(root, 'coverage', 'lcov.info'), 'TN:\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
    expect(await executions(log)).toBe(1)

    // The control: the declared root file is an edit, and the watcher was alive all along.
    await writeFile(path.join(root, 'tsconfig.base.json'), '{"a":2}\n')
    await until(
      async () => (await executions(log)) === 2,
      'the re-run after the declared root file changed',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
  }, 40_000)

  it('a --filter scope watches its upstream dependencies too: a lib edit is one cycle that rebuilds both', async () => {
    // A cycle runs what `vx run` runs — the scope plus its dependencies —
    // so the watched dirs must be the same set. Before `watchedProjects`
    // the per-project arm watched the filter's answer only, and this edit
    // was never an event: the loop printed "watching 1 project(s)" and
    // sat there. Differential: with the closure removed, the wait below
    // times out.
    const lib = await addProject(root, 'lib', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo lib >> ${log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
      files: { 'src/l.txt': 'l1\n' },
    })
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            dependsOn: ['^build'],
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    pkg['dependencies'] = { lib: '0.0.0' }
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))

    watch = startWatch(root, ['--filter', 'app'])
    const w = watch
    await until(() => w.out().includes('vx watch: watching 2 project(s)'), 'both projects watched')
    const lines = async () => (await readFile(log, 'utf8')).split('\n').filter((l) => l !== '')
    expect(await lines()).toEqual(['lib', 'run'])

    await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
    await until(async () => (await lines()).length === 4, 'the cycle after the upstream edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await lines()).toEqual(['lib', 'run', 'lib', 'run'])
  }, 40_000)

  it('an UNCACHED task that writes into its project costs exactly one extra execution per edit, then quiet', async () => {
    // No cache block declares no outputs, so the task's own `dist/out.txt`
    // is an undeclared write the watcher sees. Its bytes are unknown until
    // seen, and a user's edit during the run is indistinguishable from the
    // task's write without the task's write set — so the price is one
    // redundant cycle per edit (the second run writes the same bytes and
    // the content gate stops it), never a loop. Measured 2026-09-10; the
    // fix is to declare the output. Nothing after the initial run: its
    // write landed before the watchers were armed.
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' } } } }\n`,
    )
    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(log)).toBe(1)
    expect(w.cycles()).toBe(0)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await until(
      async () => (await executions(log)) === 3,
      'the edit cycle and its one redundant follower',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await executions(log)).toBe(3)
    expect(w.cycles()).toBe(2)
    expect(w.out()).toContain('vx watch: app dist/out.txt; re-running...')
  }, 40_000)

  it.each([
    ['no gap', ''],
    ['a gap between the delete and the rebuild, as rimraf && tsc has', 'sleep 0.3; '],
  ])(
    'an UNCACHED task that deletes and recreates its output settles after one redundant cycle (%s)',
    async (_shape, gap) => {
      // The shape of most build scripts — `rm -rf dist && tsc` — with no
      // outputs declared. Before this pin the loop never settled: a
      // deletion and a directory each passed the content gate
      // unconditionally, and with a gap the debounce fired mid-run on a
      // `dist` that was gone and not yet rebuilt (2026-09-10, one edit:
      // 780 executions in two minutes). Now a path is judged on its
      // SETTLED state, one window after the run — a directory's entries'
      // names and sizes — so the rebuilt `dist` is the `dist` the loop
      // last saw. Differential: with the gate passing directories
      // through, executions climb past 3 within the settle window.
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'rm -rf dist; ${gap}mkdir -p dist; cat src/*.txt > dist/out.txt; echo run >> ${log}' } } } }\n`,
      )
      watch = startWatch(root)
      const w = watch
      await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
      await Bun.sleep(SETTLE_MS)
      expect(await executions(log)).toBe(1)

      await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
      await until(
        async () => (await executions(log)) === 3,
        'the edit cycle and its one redundant follower',
      )
      await Bun.sleep(SETTLE_MS * 2)
      expect(await executions(log)).toBe(3)
      expect(w.cycles()).toBe(2)
      // The follower is labelled by what arrived — the task's own dist —
      // not by the edit that started the cycle it landed in.
      expect(w.out().split('re-running...')[2]).not.toContain('src/a.txt')
      expect(w.out()).toContain('vx watch: app dist')
    },
    40_000,
  )

  it('a git checkout that rewrites twenty inputs is one cycle with the new content (L5)', async () => {
    const git = gitIn(root)
    const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    for (const n of names) await writeFile(path.join(dir, 'src', n), `${n} v1\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v1')
    const base = git('branch', '--show-current').trim()
    git('checkout', '-q', '-b', 'feat')
    for (const n of names) await writeFile(path.join(dir, 'src', n), `${n} v2\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v2')
    git('checkout', '-q', base)

    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(log)).toBe(1)

    git('checkout', '-q', 'feat')
    await until(async () => (await executions(log)) === 2, 'the re-run after the checkout')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    const out = await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')
    expect(out).toBe(['a1\n', ...names.map((n) => `${n} v2\n`)].join(''))
  }, 40_000)
})
