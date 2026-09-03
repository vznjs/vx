// `vx watch`'s loop rules — the silent-when-wrong kind. A missed re-run does
// not fail; it simply never happens, and the loop keeps printing that it is
// watching. Two recorded defects route through this file, both of that shape:
// the dropped-event race that was called a timing flake three times and had its
// timeout raised twice before being root-caused (the event was LOST, so more
// time could never help), and the config-worker deadline that exists because a
// worker the OS kills fires no `error` event and its caller waits forever.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import fs, { chmodSync, existsSync } from 'node:fs'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import path from 'node:path'
import {
  armWatcher,
  isIgnoredWatchPath,
  makeWatchIgnore,
  WATCH_PROBE,
  watchCmd,
} from '../src/cli/watch.js'
import { WORKSPACE_FINGERPRINT_FILES } from '../src/workspace/index.js'

describe('the ignore filter', () => {
  // Every project dir is watched RECURSIVELY, so without this a `bun install`
  // re-runs the graph on every file it writes — and vx's own `.vx/cache` writes
  // trigger a cycle that writes to `.vx/cache` again.
  it.each([
    ['node_modules at the root', 'node_modules/pkg/index.js'],
    ['node_modules NESTED under a package', 'packages/a/node_modules/pkg/index.js'],
    ['a .git internal write', '.git/refs/heads/main'],
    ['vx’s own cache', '.vx/cache/abcdef.tar.zst'],
    ['a nested .vx dir', 'packages/a/.vx/cache/x'],
    ['a tsbuildinfo', 'packages/a/tsconfig.tsbuildinfo'],
    ['an editor swap file', 'packages/a/src/index.ts~'],
  ])('ignores %s', (_label, rel) => {
    expect(isIgnoredWatchPath(rel.split('/').join(path.sep))).toBe(true)
  })

  it.each([
    ['ordinary source', 'packages/a/src/index.ts'],
    ['a root lockfile', 'pnpm-lock.yaml'],
    ['a config', 'packages/a/vx.config.ts'],
    // The segment rule is not a substring rule: a file whose NAME merely
    // contains an ignored word is real source and must still trigger.
    ['a file named after node_modules', 'packages/a/src/node_modules-shim.ts'],
    ['a file named after .git', 'packages/a/src/dot.gitignore-parser.ts'],
    // Suffix rules anchor at the END: `~` mid-name is not a swap file.
    ['a tilde mid-name', 'packages/a/src/a~b.ts'],
  ])('does NOT ignore %s', (_label, rel) => {
    expect(isIgnoredWatchPath(rel.split('/').join(path.sep))).toBe(false)
  })
})

describe('the ignore filter follows the RESOLVED cache dir, not the .vx literal', () => {
  // `cacheDir` is a shipped `defineWorkspace` field. Point it out of `.vx/` and
  // the hard-coded segment list stops covering it, so vx's own cache writes land
  // in a watched subtree and every cycle triggers the next one. Measured through
  // the real loop before the fix: ONE edit kicked it, then 22 more cycles fired
  // during 6 seconds of TOTAL silence (~3.7 re-runs/second, indefinitely). The
  // default `.vx` cache settles at 0 in the same harness — that control is what
  // makes this the cache dir rather than the loop.
  const root = path.resolve(path.sep, 'ws')
  const proj = path.join(root, 'packages', 'app')

  it.each([
    ['the cache dir itself', path.join(root, 'build', 'vxcache')],
    ['a cache dir inside a project', path.join(proj, '.cache')],
  ])('ignores writes under %s', (_label, cacheDir) => {
    const ignore = makeWatchIgnore(cacheDir)
    expect(ignore(root, path.relative(root, path.join(cacheDir, 'cache.db')))).toBe(true)
    expect(ignore(root, path.relative(root, path.join(cacheDir, 'ab', 'cd.tar.zst')))).toBe(true)
  })

  it("drops a task's own declared outputs, under either watcher, and nothing beside them", () => {
    // A cycle that writes `dist/` must not be taken for an edit: without
    // this every edit costs a second run that reports "up-to-date".
    const proj = path.join(root, 'packages', 'app')
    const ignore = makeWatchIgnore(
      path.join(root, '.vx', 'cache'),
      new Map([
        [proj, ['dist/**', 'out.txt']],
        [root, ['generated/*.json']], // outputs.workspaceFiles, root-relative
      ]),
    )
    // per-project watcher: paths relative to the project dir
    expect(ignore(proj, path.join('dist', 'index.js'))).toBe(true)
    expect(ignore(proj, 'out.txt')).toBe(true)
    expect(ignore(proj, path.join('src', 'index.ts'))).toBe(false)
    expect(ignore(proj, 'out.txt.bak')).toBe(false)
    // root watcher: paths relative to the root resolve to the same project
    expect(ignore(root, path.join('packages', 'app', 'dist', 'index.js'))).toBe(true)
    expect(ignore(root, path.join('packages', 'app', 'src', 'index.ts'))).toBe(false)
    expect(ignore(root, path.join('generated', 'a.json'))).toBe(true)
    // another project's `dist/` is not this project's output
    expect(ignore(root, path.join('packages', 'lib', 'dist', 'index.js'))).toBe(false)
  })

  it('still ignores the .vx default when no override is set', () => {
    const ignore = makeWatchIgnore(path.join(root, '.vx', 'cache'))
    expect(ignore(root, path.join('.vx', 'cache', 'cache.db'))).toBe(true)
  })

  it('does NOT ignore ordinary source — the filter is a containment check', () => {
    // Control: the fix must not degenerate into "ignore the whole workspace".
    // A sibling whose name merely EXTENDS the cache dir is real source.
    const ignore = makeWatchIgnore(path.join(root, 'build', 'vxcache'))
    expect(ignore(proj, path.join('src', 'index.ts'))).toBe(false)
    expect(ignore(root, path.join('build', 'vxcache-notes.md'))).toBe(false)
    expect(ignore(root, path.join('build', 'app.js'))).toBe(false)
  })

  it('resolves relative to the WATCHER, so a project-relative name cannot alias', () => {
    // Each watcher reports names relative to its own dir. Resolving against the
    // wrong base would make `build/vxcache/x` under a PROJECT match the ROOT's
    // cache dir and silently drop real events.
    const ignore = makeWatchIgnore(path.join(root, 'build', 'vxcache'))
    expect(ignore(proj, path.join('build', 'vxcache', 'x'))).toBe(false)
    expect(ignore(root, path.join('build', 'vxcache', 'x'))).toBe(true)
  })
})

describe('the root-file trigger set does not drift from the fingerprint', () => {
  it('reads the shared constant instead of a hand-rolled copy', async () => {
    // A SOURCE assertion, because the defect has no runtime shape until someone
    // adds a name: `watch.ts` used to carry its own literal list of the seven
    // lockfile / workspace-definition files. That is the THIRD copy, and the
    // `--affected` wave exported `WORKSPACE_FINGERPRINT_FILES` precisely so a
    // second could not drift — it just missed this one.
    //
    // Add a name to the shared constant and, before the fix: every task's cache
    // key folds it, `--affected` widens on it, and `vx watch` silently never
    // re-runs on it. The loop looks alive while ignoring the one edit that
    // invalidates the entire workspace.
    const src = await Bun.file(path.join(import.meta.dir, '..', 'src', 'cli', 'watch.ts')).text()
    expect(src).toContain('WORKSPACE_FINGERPRINT_FILES')
    // No hand-rolled literals: re-adding the list fails HERE rather than
    // silently reintroducing the drift — and this guard is not redundant with
    // the lockfile e2e in cli.test.ts. Measured: with the hand-rolled list
    // restored, that e2e still PASSES, because both lists carry the same seven
    // names today. It only starts failing once someone adds a name to one of
    // them, which is exactly the moment nobody is looking.
    for (const name of WORKSPACE_FINGERPRINT_FILES) {
      expect({ name, hardcoded: src.includes(`'${name}'`) }).toEqual({ name, hardcoded: false })
    }
  })

  it('the shared constant still covers every manager vx fingerprints', () => {
    // A control on the constant itself, so "reads the shared list" cannot pass
    // by the shared list quietly shrinking.
    expect([...WORKSPACE_FINGERPRINT_FILES].sort()).toEqual([
      'bun.lock',
      'bun.lockb',
      'npm-shrinkwrap.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'yarn.lock',
    ])
  })
})

describe('flags that format ONE run are refused, not silently ignored', () => {
  let stderr: string
  beforeEach(() => {
    stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // `--report` / `--report-file` / `--verbosity` are consumed by `runCmd`
  // alone, so a watch loop used to accept and silently drop them. The flag NAME
  // and the REASON are asserted separately on purpose: pinning the exact prose
  // has already broken these tests once, when a third flag joined the message.
  //
  // NB `--verbosity 0` is deliberately NOT refused — it asks for the output
  // watch already gives, which is why the check is `> 0` rather than
  // `!== undefined`. That boundary IS guarded, just not here: `verbosity`
  // defaults to 0, so tightening the comparison to `>= 0` rejects EVERY watch
  // invocation, and the e2e block in cli.test.ts reds immediately (measured: 7
  // failures). A unit for it would have to reach a real orchestrator run, so
  // this file deliberately stops at the refusals.
  it.each([
    ['--report', ['build', '--report']],
    ['--report-file', ['build', '--report-file=/tmp/x.md']],
    ['--verbosity', ['build', '--verbosity', '2']],
  ])('refuses %s', async (flag, argv) => {
    expect(await watchCmd(argv)).toBe(1)
    expect({ flag, named: stderr.includes(flag) }).toEqual({ flag, named: true })
    expect(stderr).toContain('single run')
  })
})

// `vx watch` prints "watching" only after each watcher has reported a probe
// file written under it — on macOS a recursive watcher can return before its
// FSEvents stream is live, and an edit in that gap is lost (5/30 under load,
// measured 2026-09-03). This pins the helper's contract: readiness is proved
// by the probe, the probe never reaches the caller, and it is gone afterwards.
describe('armWatcher', () => {
  for (const recursive of [true, false]) {
    it(`proves delivery with a probe it then removes (recursive: ${recursive})`, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-arm-'))
      const seen: string[] = []
      const armed = armWatcher(dir, recursive, (f) => seen.push(f))
      try {
        expect(await armed.ready).toBe(true)
        expect(existsSync(path.join(dir, WATCH_PROBE))).toBe(false)
        // A real edit after readiness is delivered; the probe never was.
        await writeFile(path.join(dir, 'edit.txt'), 'x')
        const start = Date.now()
        while (!seen.includes('edit.txt') && Date.now() - start < 3000) await Bun.sleep(5)
        expect(seen).toContain('edit.txt')
        expect(seen).not.toContain(WATCH_PROBE)
      } finally {
        armed.watcher.close()
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
})

// The differential for the proof itself: a watcher that never speaks must
// yield `ready === false`. A helper that resolved without waiting for the
// probe's event would pass the real-watcher pins above and fail this one.
describe('armWatcher against a fake fs.watch', () => {
  afterEach(() => vi.restoreAllMocks())

  function fakeWatch(deliver: boolean): { closed: () => boolean } {
    let closed = false
    vi.spyOn(fs, 'watch').mockImplementation(((
      _dir: string,
      _opts: unknown,
      cb: (event: string, filename: string) => void,
    ) => {
      if (deliver) queueMicrotask(() => cb('rename', WATCH_PROBE))
      return { close: () => (closed = true) } as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch)
    return { closed: () => closed }
  }

  it('a watcher that never reports the probe is NOT ready', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-arm-silent-'))
    fakeWatch(false)
    try {
      const armed = armWatcher(dir, true, () => {}, 100)
      expect(await armed.ready).toBe(false)
      expect(existsSync(path.join(dir, WATCH_PROBE))).toBe(false) // cleaned up either way
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a watcher that reports the probe is ready, and the caller never sees the probe', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-arm-fake-'))
    fakeWatch(true)
    const seen: string[] = []
    try {
      const armed = armWatcher(dir, true, (f) => seen.push(f), 100)
      expect(await armed.ready).toBe(true)
      expect(seen).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// An unwritable watched directory (a project made read-only, or removed and
// recreated under a stricter mode) cannot take a probe: `ready` is false at
// once — no wait on an impossible write — and the watcher is kept, so a later
// permission fix still delivers. Executed 2026-09-03 (4 ms, no throw).
describe('armWatcher on an unwritable directory', () => {
  it.skipIf(process.getuid?.() === 0)(
    'reports not-ready immediately and keeps the watcher',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-arm-ro-'))
      chmodSync(dir, 0o500)
      try {
        const t0 = Date.now()
        const armed = armWatcher(dir, true, () => {}, 2_000)
        expect(await armed.ready).toBe(false)
        expect(Date.now() - t0).toBeLessThan(1_000) // it did not sit out the 2 s budget
        armed.watcher.close()
      } finally {
        chmodSync(dir, 0o700)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})
