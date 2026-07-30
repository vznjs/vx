// `vx watch`'s loop rules — the silent-when-wrong kind. A missed re-run does
// not fail; it simply never happens, and the loop keeps printing that it is
// watching. Two recorded defects route through this file, both of that shape:
// the dropped-event race that was called a timing flake three times and had its
// timeout raised twice before being root-caused (the event was LOST, so more
// time could never help), and the config-worker deadline that exists because a
// worker the OS kills fires no `error` event and its caller waits forever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import path from 'node:path'
import { isIgnoredWatchPath, watchCmd } from '../src/cli/watch.js'
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
