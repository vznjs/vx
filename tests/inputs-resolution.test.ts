// `src/cache/inputs.ts` decides WHICH FILES fold into every cache key. That
// makes it the narrowest place in the codebase where a one-character change
// becomes a silent wrong answer, in both directions:
//
//   A file wrongly EXCLUDED is a STALE HIT — the key stops moving with the
//   source, vx replays yesterday's artifact and prints `up-to-date`. Nothing
//   throws. The decision log records eight separate stale-hit defects and
//   several of them route through this file.
//
//   A file wrongly INCLUDED is a cache that never hits — a performance bug
//   that reads to the user as "caching is broken".
//
// `tests/inputs.test.ts` already covers the git-enumeration path (gitignore
// cascade, untracked files, deleted-but-tracked, the bulk populate) and the
// basic `cleanOutputs` ownership contract. This file deliberately does NOT
// re-tread that ground. It covers the *resolution semantics* layered on top of
// the git file set: how negation composes, what ALWAYS_IGNORE really matches,
// where the project boundary holds and where it is deliberately absent, and
// which guards are load-bearing versus incidental properties of Bun.Glob.
//
// Several assertions below are FINDINGS: current behaviour that is wrong,
// pinned rather than fixed so the next reader inherits the knowledge instead of
// rediscovering it. Each is marked and states what the correct behaviour would
// be.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import {
  cleanOutputs,
  cleanWorkspaceOutputs,
  GitFilesCache,
  resolveInputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
} from '../src/cache/inputs.js'
import { loadProjectConfig, validateProjectConfig } from '../src/workspace/project-loader.js'
import type { CacheInputs } from '../src/config.js'

// Every fixture git-inits a real repo; under full-suite load the default 5s
// hook budget is tight. File-scoped, matching tests/inputs.test.ts.
setDefaultTimeout(30_000)

async function write(p: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

/**
 * vx defers to `git ls-files` for the input file set and raises a UserError
 * without a work tree, so every fixture that resolves a non-empty glob needs a
 * real repo. Signing is disabled explicitly: a global `commit.gpgsign` plus a
 * GPG agent would hang the fixture waiting for approval.
 */
function gitInit(cwd: string): void {
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@vx.local'],
    ['config', 'user.name', 'vx test'],
    ['config', 'commit.gpgsign', 'false'],
  ]) {
    const p = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Negation semantics
//
// The mechanism is one partition in `resolveFiles` / `resolveWorkspaceFiles`:
// entries starting with `!` go to `negative`, everything else to `positive`.
// The positives SELECT; the negatives are appended to a flat exclude set
// alongside ALWAYS_IGNORE, the boundary globs, and the task's own outputs.
//
// That is NOT gitignore. gitignore is an ordered last-match-wins scan where a
// later `!` re-includes; here nothing ever re-includes, and position carries no
// meaning at all. Users arrive with the gitignore model, which is why every
// confusion in this block ends in a silently empty input set.
// ─────────────────────────────────────────────────────────────────────────
describe('negation composes by subtraction only — it is not gitignore', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-neg-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    gitInit(root)
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')
    await write(path.join(projectDir, 'src', 'b.ts'), 'b')
    await write(path.join(projectDir, 'vendor', 'v.js'), 'v')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function rels(files: string[]): Promise<string[]> {
    return resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files },
      ownOutputs: [],
      nestedProjectDirs: [],
    }).then((r) => r.files.map((f) => path.relative(projectDir, f)))
  }

  it('a negation-only list folds ZERO files', async () => {
    // The resolver builds its candidate set from the POSITIVE globs and returns
    // early when there are none — so `['!**/*.spec.ts']`, which every
    // gitignore-trained reader parses as "everything except specs", selects
    // nothing at all. The task's key then folds no file inputs and stops
    // tracking its own source: a stale hit, and a silent one.
    //
    // The LOADER now refuses this shape outright (`assertNotNegationOnly`,
    // covered in tests/project-loader.test.ts). This pins the RESOLVER
    // behaviour the loader guard exists to prevent — if the guard is ever
    // relaxed, this is what it lets through.
    expect(await rels(['!**/*.spec.ts'])).toEqual([])
    expect(await rels(['!src/**', '!vendor/**'])).toEqual([])
  })

  it('position is irrelevant: a negation listed FIRST still subtracts', async () => {
    // gitignore is ordered — a later `!pattern` re-includes what an earlier
    // pattern excluded. Here the two lists are partitioned before any matching
    // happens, so ordering carries no information whatsoever. Pinned because
    // the natural "fix" for the gitignore mismatch is to make the list ordered,
    // and that would silently change the meaning of every existing config.
    const before = await rels(['!src/a.ts', 'src/**'])
    const after = await rels(['src/**', '!src/a.ts'])
    expect(before).toEqual([path.join('src', 'b.ts')])
    expect(after).toEqual(before)
  })

  it('a negation can never re-include a path ALWAYS_IGNORE excluded', async () => {
    // Negatives are appended to the same flat exclude set ALWAYS_IGNORE feeds,
    // so `!node_modules/**` reads as "exclude it" a second time, never as
    // "bring it back". A user trying to opt node_modules into the key has no
    // way to do it, and gets no error saying so.
    await write(path.join(projectDir, 'node_modules', 'dep', 'index.js'))
    expect(await rels(['**/*', '!node_modules/**'])).not.toContain(
      path.join('node_modules', 'dep', 'index.js'),
    )
  })

  it('a negation can never re-include the task’s own declared output', async () => {
    // `ownOutputs` is folded into the same exclude set. A task cannot
    // invalidate itself, and no glob syntax can opt back in — which is the
    // intended contract, pinned so the exclude set stays a union rather than
    // becoming an ordered scan.
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: ['src/a.ts'],
      nestedProjectDirs: [],
    })
    const seen = got.files.map((f) => path.relative(projectDir, f))
    expect(seen).not.toContain(path.join('src', 'a.ts'))
    expect(seen).toContain(path.join('src', 'b.ts'))
  })

  it('FINDING: `!!glob` INVERTS the input set, dropping every other file', async () => {
    // FINDING — stale-hit class, currently shipped, loader does not catch it.
    //
    // Mechanism: `resolveFiles` strips ONE leading `!` and hands the remainder
    // to `new Bun.Glob(...)`. Bun.Glob applies its OWN leading-`!` negation, so
    // the exclude glob built from `'!!vendor/**'` is `Glob('!vendor/**')`,
    // which matches EVERYTHING EXCEPT vendor. Exclusion is
    // `excludeGlobs.some(g => g.match(rel))`, so every non-vendor file is
    // excluded and only `vendor/**` survives — the exact inverse of any reading
    // of the config, and the inverse of the single-`!` form one character away.
    //
    // Impact: `src/a.ts` is no longer in the key. Edit it, and vx reports
    // `up-to-date` while replaying the old artifact.
    //
    // Correct behaviour: reject a leading `!!` at the loader (the remainder is
    // never a meaningful glob), or escape the stripped remainder before
    // constructing the Glob so `!!x` means the literal path `!x`.
    expect(await rels(['**/*', '!vendor/**'])).toEqual([
      path.join('src', 'a.ts'),
      path.join('src', 'b.ts'),
    ])
    expect(await rels(['**/*', '!!vendor/**'])).toEqual([path.join('vendor', 'v.js')])
  })

  it('the loader REFUSES the inverting `!!` form', async () => {
    // The two guards that could have caught it both miss on their own:
    // `assertNotNegationOnly` sees the positive `**/*` and passes, and
    // `hasParentSegment` strips one `!` before splitting so `'!!vendor/**'`
    // shows no `..` segment. Neither is wrong — they answer different
    // questions — which is why this needed its own guard rather than a
    // widening of either.
    //
    // This test began as a FINDING pinning the loader ACCEPTING the form.
    // Flipping it to assert the refusal is the intended end of that loop: the
    // pin is what announced the fix, and it stays here so the acceptance
    // cannot come back silently.
    const dir = path.join(root, 'cfgpkg')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      'export default { tasks: { build: { exec: { command: "true" }, ' +
        'cache: { inputs: { files: ["**/*", "!!vendor/**"] }, outputs: { files: [] } } } } }',
    )
    await expect(loadProjectConfig(path.join(dir, 'vx.config.mjs'))).rejects.toThrow(
      /'!!' is not a double negation/,
    )
  })

  it('the refusal names both repairs, because the two differ by one character', () => {
    // A reader hitting this wrote `!!x` meaning "definitely exclude x". The
    // message has to say which of the two one-character neighbours they wanted,
    // since the wrong pick is silent: `!x` subtracts it, `x` includes it, and
    // `!!x` folds ONLY it.
    let msg = ''
    try {
      validateProjectConfig(
        {
          tasks: {
            build: {
              exec: { command: 'true' },
              cache: { inputs: { files: ['**/*', '!!vendor/**'] }, outputs: { files: [] } },
            },
          },
        },
        'cfg',
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('INVERTS')
    expect(msg).toContain('"!vendor/**"')
    expect(msg).toContain('"vendor/**"')
    expect(msg).toContain('cache.inputs.files')
  })

  it('the workspace half is refused too — a one-sided fix would leave it live', () => {
    // `resolveWorkspaceFiles` carries its OWN copy of the `startsWith('!')`
    // partition, so the defect exists twice. Pinned separately for exactly
    // that reason: a fix applied to one half passes the other half's tests.
    expect(() =>
      validateProjectConfig(
        {
          tasks: {
            build: {
              exec: { command: 'true' },
              cache: {
                inputs: { files: [], workspaceFiles: ['**/*', '!!pkg/vendor/**'] },
                outputs: { files: [] },
              },
            },
          },
        },
        'cfg',
      ),
    ).toThrow(/'!!' is not a double negation/)
  })

  it('a single `!` and a plain positive are both still accepted', () => {
    // The control. Both neighbours of `!!x` are legitimate and common, so a
    // guard that caught them would break every config that subtracts anything.
    expect(() =>
      validateProjectConfig(
        {
          tasks: {
            build: {
              exec: { command: 'true' },
              cache: {
                inputs: { files: ['**/*', '!vendor/**'], workspaceFiles: ['a/**', '!a/b/**'] },
                outputs: { files: ['dist/**'] },
              },
            },
          },
        },
        'cfg',
      ),
    ).not.toThrow()
  })

  it('FINDING: `!!` inverts `workspaceFiles` the same way', async () => {
    // FINDING — same defect, second call site. `resolveWorkspaceFiles` carries
    // its own copy of the `startsWith('!')` partition, so a fix applied to only
    // one of the two leaves this half live. Recorded separately for exactly
    // that reason.
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['**/*', '!!pkg/vendor/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(root, f))).toEqual([
      path.join('pkg', 'vendor', 'v.js'),
    ])
  })

  it('a negation-only workspaceFiles list contributes nothing, leaving project files intact', async () => {
    // `resolveWorkspaceFiles` returns `[]` on an empty positive list, and
    // `resolveInputs` only merges when the workspace list is non-empty — so the
    // project half must pass through untouched rather than being dropped by the
    // merge. That "leaves the other half alone" half is the part a naive
    // refactor of the merge would break.
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'], workspaceFiles: ['!**/*.md'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual([
      path.join('src', 'a.ts'),
      path.join('src', 'b.ts'),
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// ALWAYS_IGNORE
//
// Six patterns, applied to project inputs AND workspace inputs. Each is
// `**/`-prefixed, and the whole guarantee rests on `**/` matching ZERO
// directories as well as many — otherwise a top-level `node_modules` would sail
// straight into the key. Both directions are asserted: the patterns must match
// every nested form, and must NOT swallow innocent neighbours (`.github`
// dropping out of a key is a silent stale hit for every CI-config change).
// ─────────────────────────────────────────────────────────────────────────
describe('ALWAYS_IGNORE matches nested AND top-level forms', () => {
  let root: string
  let projectDir: string

  // Each entry: the path to plant, relative to the project dir.
  const IGNORED_TOP = [
    'node_modules/dep/index.js',
    '.git/HEAD',
    '.vx/cache/log',
    'tsconfig.tsbuildinfo',
    'vx-lock.json',
    '.18bf7d9ff3ffeffe-00000001.bun-build',
  ]
  const IGNORED_NESTED = [
    'a/b/node_modules/dep/index.js',
    'a/b/.git/HEAD',
    'a/b/.vx/cache/log',
    'a/b/tsconfig.tsbuildinfo',
    'a/b/vx-lock.json',
    'a/b/.18bf7d9ff3ffeffe-00000001.bun-build',
  ]
  // Names one character away from an ignored one. If any of these is excluded
  // the pattern is over-broad, and a real source file has silently left the key.
  const KEPT_NEAR_MISSES = [
    '.github/workflows/ci.yml',
    '.gitignore',
    '.vxrc',
    'my_node_modules/x.js',
    'x.tsbuildinfo.bak',
    'vx-lock.json.bak',
    'x.bun-build.txt',
  ]

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-ignore-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    gitInit(root)
    await write(path.join(projectDir, 'src', 'keep.ts'), 'keep')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function resolveAll(): Promise<string[]> {
    // `-f` forces git to track paths its own ignore rules would hide, so what
    // this measures is vx's ALWAYS_IGNORE filter rather than git's cascade.
    Bun.spawnSync({ cmd: ['git', 'add', '-Af'], cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    return got.files.map((f) => path.relative(projectDir, f))
  }

  it('excludes every ALWAYS_IGNORE pattern at the top level of a project', async () => {
    for (const rel of IGNORED_TOP) await write(path.join(projectDir, rel))
    const seen = await resolveAll()
    expect(seen).toEqual([path.join('src', 'keep.ts')])
  })

  it('excludes every ALWAYS_IGNORE pattern NESTED under a project', async () => {
    // The `**/` prefix has to match many directories as well as zero. A pattern
    // written as `node_modules/**` would pass the test above and fail here,
    // letting a transitively-installed dep tree into every key.
    for (const rel of IGNORED_NESTED) await write(path.join(projectDir, rel))
    const seen = await resolveAll()
    expect(seen).toEqual([path.join('src', 'keep.ts')])
  })

  it('does NOT exclude names that merely resemble an ignored one', async () => {
    // The over-exclusion direction. `.github/**` dropping out of the key means
    // a workflow edit never invalidates anything — same silent failure as any
    // other missing input, and far harder to notice.
    for (const rel of KEPT_NEAR_MISSES) await write(path.join(projectDir, rel))
    const seen = await resolveAll()
    for (const rel of KEPT_NEAR_MISSES) {
      expect(seen).toContain(rel.split('/').join(path.sep))
    }
  })

  it('applies to workspaceFiles too, not just project files', async () => {
    // The two resolvers each build their own exclude list. A fix or a
    // regression applied to one does not reach the other, so the guarantee is
    // asserted on both paths.
    await write(path.join(root, 'node_modules', 'dep', 'index.js'))
    await write(path.join(root, 'vx-lock.json'), '{}')
    await write(path.join(root, 'tsconfig.json'), '{}')
    Bun.spawnSync({ cmd: ['git', 'add', '-Af'], cwd: root, stdout: 'pipe', stderr: 'pipe' })

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    const seen = got.files.map((f) => path.relative(root, f))
    expect(seen).toContain('tsconfig.json')
    expect(seen).not.toContain(path.join('node_modules', 'dep', 'index.js'))
    expect(seen).not.toContain('vx-lock.json')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The project boundary
//
// "A project's globs never reach into another project's dir" is architecture
// principle #6. It is enforced by exactly one mechanism: `boundaryIgnorePatterns`
// turns each nested project dir into a `<rel>/**` exclude glob. Both directions
// matter — a leak folds a sibling's source into this task's key (and lets
// `cleanOutputs` delete it), while an over-broad exclusion drops the parent's
// own files.
// ─────────────────────────────────────────────────────────────────────────
describe('the hard project boundary holds in both directions', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-bound-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    gitInit(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('excludes a nested project while keeping the parent’s files at the SAME depth', async () => {
    // The direction a boundary check most easily gets wrong: excluding by depth
    // or by a prefix that is too short takes the parent's own `inner.ts` with
    // it. `inner/` is nested; `outer/` sits beside it at identical depth and
    // must survive.
    const nested = path.join(projectDir, 'inner')
    await write(path.join(nested, 'src', 'nested.ts'))
    await write(path.join(projectDir, 'outer', 'src', 'parent.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [nested],
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual([
      path.join('outer', 'src', 'parent.ts'),
    ])
  })

  it('a sibling whose name EXTENDS the nested project’s name is not excluded', async () => {
    // The interloper class. `computeNestedProjectDirs` shipped a defect where
    // `foo-utils` sorting between `foo` and `foo/` broke the nested-set scan;
    // the same shape has to be checked here, one layer down. The exclude glob
    // is `inner/**`, which must not swallow `inner-utils/`. If the boundary
    // ever became a bare `startsWith` on the directory string, it would.
    const nested = path.join(projectDir, 'inner')
    await write(path.join(nested, 'nested.ts'))
    await write(path.join(projectDir, 'inner-utils', 'util.ts'))
    await write(path.join(projectDir, 'inner.config.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [nested],
    })
    const seen = got.files.map((f) => path.relative(projectDir, f))
    expect(seen).toContain(path.join('inner-utils', 'util.ts'))
    expect(seen).toContain('inner.config.ts')
    expect(seen).not.toContain(path.join('inner', 'nested.ts'))
  })

  it('excludes a project nested several levels down', async () => {
    // The boundary is computed from the relative path, so depth is incidental —
    // but a hand-rolled single-segment pattern would only catch direct children.
    const deep = path.join(projectDir, 'a', 'b', 'inner')
    await write(path.join(deep, 'nested.ts'))
    await write(path.join(projectDir, 'a', 'b', 'parent.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [deep],
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual([
      path.join('a', 'b', 'parent.ts'),
    ])
  })

  it('resolveOutputs keeps the parent’s same-depth files while excluding the nested project', async () => {
    // `resolveOutputs` feeds `cleanOutputs`, which DELETES what it resolves, so
    // the over-exclusion direction is a correctness bug and the under-exclusion
    // direction is data loss in someone else's project. Both in one assertion.
    const nested = path.join(projectDir, 'inner')
    await write(path.join(nested, 'dist', 'nested.js'))
    await write(path.join(projectDir, 'dist', 'parent.js'))

    const out = await resolveOutputs({
      projectDir,
      outputs: ['**/*.js'],
      nestedProjectDirs: [nested],
    })
    expect(out).toEqual([path.join(projectDir, 'dist', 'parent.js')])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// resolveOutputs / cleanOutputs — the data-loss surface
//
// `cleanOutputs` rm()s everything `resolveOutputs` returns, before every cache
// hit AND before every cache miss. There is NO containment check inside either
// function: whatever the glob resolves to is deleted. The `..` and absolute
// rejections live entirely in the loader, and the tests below exist to make the
// cost of removing them concrete.
// ─────────────────────────────────────────────────────────────────────────
describe('output resolution contains itself — the loader guard is now the SECOND layer', () => {
  let root: string
  let projectDir: string
  let victim: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-outesc-'))
    projectDir = path.join(root, 'pkg')
    victim = path.join(root, 'victim')
    await mkdir(projectDir, { recursive: true })
    await write(path.join(victim, 'precious.txt'), 'precious')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a `..` output glob resolves to NOTHING and deletes nothing', async () => {
    // FIXED 2026-08-04 — this previously asserted the OPPOSITE, as a
    // demonstration that the loader's `hasParentSegment` rejection was the ONLY
    // thing between a typo'd config and deleting a sibling project's source
    // tree. `Bun.Glob.scan` still walks `..` out of its cwd; what changed is
    // that `resolveOutputs` now drops anything outside the project before
    // `cleanOutputs` can delete it. The loader rejection remains, and is now
    // genuinely defence-in-depth rather than a single point of failure.
    const escaped = await resolveOutputs({
      projectDir,
      outputs: ['../victim/**'],
      nestedProjectDirs: [],
    })
    expect(escaped).toEqual([])

    await cleanOutputs({ projectDir, outputs: ['../victim/**'], nestedProjectDirs: [] })
    expect(existsSync(path.join(victim, 'precious.txt'))).toBe(true)
  })

  it('an ABSOLUTE output glob resolves to NOTHING too', async () => {
    // Same story for the absolute form, which is worse in scale — an absolute
    // glob is bounded only by the filesystem. Also previously asserted the
    // opposite; the containment filter drops it for the same reason.
    const escaped = await resolveOutputs({
      projectDir,
      outputs: [`${victim}/**`],
      nestedProjectDirs: [],
    })
    expect(escaped).toEqual([])
    expect(existsSync(path.join(victim, 'precious.txt'))).toBe(true)
  })

  it('a NORMAL output glob is unaffected — the filter is containment, not a ban', () => {
    // The control. Without it, "resolve nothing" would satisfy every assertion
    // above while breaking every real config.
    return (async () => {
      await write(path.join(projectDir, 'dist/app.js'), 'built')
      const inside = await resolveOutputs({
        projectDir,
        outputs: ['dist/**'],
        nestedProjectDirs: [],
      })
      expect(inside).toEqual([path.join(projectDir, 'dist/app.js')])
    })()
  })

  it('a symlinked output dir resolves to NOTHING — Bun.Glob.scan does not follow it', async () => {
    // `dist -> ../victim` is the escape the loader cannot see: the glob is a
    // blameless `dist/**` with no `..` and no leading `/`, and the traversal
    // happens on disk. What saves us is that `Bun.Glob.scan` does not descend
    // into symlinked directories — not any check vx performs.
    //
    // So this pins a property of a DEPENDENCY, and that is the point: if Bun
    // ever adds symlink following (or someone adds a `followSymlinks` option
    // for a good reason), `cleanOutputs` starts deleting through the link and
    // no vx guard fires. This test is the tripwire.
    await symlink(victim, path.join(projectDir, 'dist'))

    expect(
      await resolveOutputs({ projectDir, outputs: ['dist/**'], nestedProjectDirs: [] }),
    ).toEqual([])
    // Also true for a literal path through the link, not just a wildcard.
    expect(
      await resolveOutputs({
        projectDir,
        outputs: ['dist/precious.txt'],
        nestedProjectDirs: [],
      }),
    ).toEqual([])

    const removed = await cleanOutputs({ projectDir, outputs: ['dist/**'], nestedProjectDirs: [] })
    expect(removed).toEqual([])
    expect(await readFile(path.join(victim, 'precious.txt'), 'utf8')).toBe('precious')
    // The link itself survives too: `onlyFiles: true` never yields it, so
    // there is nothing for `rm` to target.
    expect(existsSync(path.join(projectDir, 'dist'))).toBe(true)
  })

  it('FINDING: a negation in outputs.files is a silent no-op', async () => {
    // FINDING — currently guarded at the loader, pinned here as the reason.
    //
    // `resolveOutputs` never splits on `!`; it passes each entry straight to
    // `scanUnion` as a positive pattern. `'!dist/*.map'` is therefore read as a
    // literal path beginning with `!`, matches nothing, and subtracts nothing —
    // so `['dist/**', '!dist/*.map']` captures AND deletes the .map files the
    // author believed they had excluded.
    //
    // Correct behaviour is what the loader now does: refuse it, because
    // supporting subtraction here would change which files existing configs
    // capture. Pinned so nobody "adds negation support" to the resolver without
    // realising that is a cache-artifact change.
    await write(path.join(projectDir, 'dist', 'a.js'))
    await write(path.join(projectDir, 'dist', 'a.map'))

    const out = await resolveOutputs({
      projectDir,
      outputs: ['dist/**', '!dist/*.map'],
      nestedProjectDirs: [],
    })
    expect(out.map((f) => path.relative(projectDir, f))).toEqual([
      path.join('dist', 'a.js'),
      path.join('dist', 'a.map'),
    ])
  })

  it('cleanOutputs reports what it removed, so staleness bookkeeping can follow', async () => {
    // The return value is not decoration: the caller feeds it to
    // `GitFilesCache.markOutputsChanged`, which is how a downstream task in the
    // same project learns its snapshot may be stale. Dropping or truncating it
    // reintroduces the stale-snapshot class the marking exists to close.
    //
    // NOTE (deliberate gap): the implementation also runs
    // `.split(path.sep).join('/')` to force posix separators. On Linux
    // `path.sep === '/'`, so that transform is the IDENTITY and NO assertion
    // written here can distinguish it from its absence. Asserting posix
    // separators would pass with the normalization deleted — a false guarantee.
    // It is left unpinned and recorded instead.
    await write(path.join(projectDir, 'dist', 'b.js'))
    await write(path.join(projectDir, 'dist', 'a.js'))

    const removed = await cleanOutputs({
      projectDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(removed.sort()).toEqual(['dist/a.js', 'dist/b.js'])
  })

  it('cleanWorkspaceOutputs reports root-relative paths and wipes root-anchored globs', async () => {
    // The workspace twin, anchored at the root rather than the project. Its
    // return feeds `markWorkspaceOutputsChanged`, which fans the paths to every
    // partition that can see them — so the anchor being the ROOT (not the
    // project) is load-bearing for that forwarding to line up.
    await write(path.join(root, 'generated', 'schema.ts'), 'gen')
    const removed = await cleanWorkspaceOutputs({
      workspaceRoot: root,
      outputs: ['generated/**'],
    })
    expect(removed).toEqual(['generated/schema.ts'])
    expect(existsSync(path.join(root, 'generated', 'schema.ts'))).toBe(false)
  })

  it('an empty output list resolves and cleans nothing at all', async () => {
    // Pins the OBSERVABLE contract — nothing resolved, nothing deleted — and
    // deliberately not the early return that implements it. Mutation-verified:
    // deleting `if (args.outputs.length === 0) return []` keeps every test in
    // this file green, because `scanUnion` over zero patterns already yields the
    // empty set. It is a short-circuit (one avoided scan, and for the workspace
    // twin one avoided git spawn), not a behaviour. Claiming otherwise here
    // would be a false guarantee.
    await write(path.join(projectDir, 'dist', 'a.js'))
    expect(await resolveWorkspaceOutputs({ workspaceRoot: root, outputs: [] })).toEqual([])
    expect(await cleanOutputs({ projectDir, outputs: [], nestedProjectDirs: [] })).toEqual([])
    expect(existsSync(path.join(projectDir, 'dist', 'a.js'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// workspaceFiles — the deliberate absence of a boundary
//
// `inputs.workspaceFiles` / `outputs.workspaceFiles` are root-anchored and
// carry NO project-boundary rule. That is documented as the escape hatch for
// shared root inputs, and it looks exactly like the bug the boundary exists to
// prevent — so it gets pinned, or a future "boundary hardening" sweep silently
// breaks every config that relies on it.
// ─────────────────────────────────────────────────────────────────────────
describe('workspaceFiles deliberately ignores project boundaries', () => {
  let root: string
  let projA: string
  let projB: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-'))
    projA = path.join(root, 'packages', 'a')
    projB = path.join(root, 'packages', 'b')
    await mkdir(projA, { recursive: true })
    await mkdir(projB, { recursive: true })
    gitInit(root)
    await write(path.join(projA, 'src', 'a.ts'), 'a')
    await write(path.join(projB, 'src', 'b.ts'), 'b')
    await write(path.join(root, 'tsconfig.json'), '{}')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reaches INTO a sibling project’s directory (this is the feature)', async () => {
    // Project A declaring `packages/b/**` as a workspace input is legal and
    // must keep working — `resolveWorkspaceFiles` is passed no nested-project
    // dirs and applies no boundary globs. The nestedProjectDirs argument is
    // supplied here precisely to show it does NOT gate the workspace half.
    const got = await resolveInputs({
      projectDir: projA,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['packages/b/**'] },
      ownOutputs: [],
      nestedProjectDirs: [projB],
    })
    expect(got.files.map((f) => path.relative(root, f))).toEqual([
      path.join('packages', 'b', 'src', 'b.ts'),
    ])
  })

  it('excludes the task’s own declared workspace outputs (no self-invalidation)', async () => {
    // The workspace analogue of the `ownOutputs` rule. Without it a task that
    // writes a root-level generated file and also globs the root would fold its
    // own output into its key, and could never hit twice in a row.
    const got = await resolveInputs({
      projectDir: projA,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['**/*'] },
      ownOutputs: [],
      ownWorkspaceOutputs: ['packages/b/**'],
      nestedProjectDirs: [],
    })
    const seen = got.files.map((f) => path.relative(root, f))
    expect(seen).toContain('tsconfig.json')
    expect(seen).not.toContain(path.join('packages', 'b', 'src', 'b.ts'))
  })

  it('a path reachable from BOTH lists contributes exactly once', async () => {
    // When the project dir IS the workspace root — the root `"."` member of this
    // very repo — the two globs enumerate the same tree and every file arrives
    // twice. `Cache.key` folds the list positionally, so a duplicate is not
    // merely untidy: it changes the digest. The Set in `resolveInputs` is what
    // keeps a root project's key stable against that.
    const got = await resolveInputs({
      projectDir: root,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'], workspaceFiles: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(new Set(got.files).size).toBe(got.files.length)
    expect(got.files.map((f) => path.relative(root, f))).toEqual([
      path.join('packages', 'a', 'src', 'a.ts'),
      path.join('packages', 'b', 'src', 'b.ts'),
      'tsconfig.json',
    ])
  })

  it('the merged list is sorted, not project-first-then-workspace', async () => {
    // `Cache.key` folds files in the order given, so concatenation order is key
    // input. Without the sort the digest would depend on which half a file came
    // from — and a root file sorting BEFORE the project's files (README.md vs
    // packages/…) is what makes the difference observable at all.
    await write(path.join(root, 'README.md'), 'readme')
    const got = await resolveInputs({
      projectDir: projA,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'], workspaceFiles: ['README.md'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(root, f))).toEqual([
      'README.md',
      path.join('packages', 'a', 'src', 'a.ts'),
    ])
  })

  it('project and workspace OUTPUT resolution of the same glob collide on one absolute path', async () => {
    // For the root project, `outputs.files: ['gen/**']` and
    // `outputs.workspaceFiles: ['gen/**']` resolve to the SAME absolute file.
    // The artifact keeps them apart by namespace (`outputs/<rel>` versus
    // `workspace-outputs/<rel>`), and this is the reason that namespace split
    // exists — at the resolver level there is nothing to tell them apart.
    // Pinned so the namespaces are never collapsed as "redundant".
    await write(path.join(root, 'gen', 'schema.ts'), 'gen')
    const asProject = await resolveOutputs({
      projectDir: root,
      outputs: ['gen/**'],
      nestedProjectDirs: [],
    })
    const asWorkspace = await resolveWorkspaceOutputs({
      workspaceRoot: root,
      outputs: ['gen/**'],
    })
    expect(asProject).toEqual([path.join(root, 'gen', 'schema.ts')])
    expect(asWorkspace).toEqual(asProject)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Enumeration order
// ─────────────────────────────────────────────────────────────────────────
describe('resolved file order is stable regardless of enumeration order', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-order-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    gitInit(root)
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')
    await write(path.join(projectDir, 'src', 'b.ts'), 'b')
    await write(path.join(projectDir, 'src', 'c.ts'), 'c')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('sorts the project file list even when the source enumeration is unsorted', async () => {
    // `Cache.key` folds the file list positionally, so enumeration order IS key
    // input. git happens to emit sorted output today, which means a test driven
    // through a real spawn cannot distinguish the sort from its absence — it
    // would pass either way, and be worthless.
    //
    // Injecting an UNSORTED snapshot through the memo is what makes this
    // discriminating: `snapshotFor` hands back exactly what was `set`, so the
    // sort is the only thing that can put the result back in order.
    const memo = new GitFilesCache()
    memo.set(projectDir, ['src/c.ts', 'src/a.ts', 'src/b.ts'])

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: memo,
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual([
      path.join('src', 'a.ts'),
      path.join('src', 'b.ts'),
      path.join('src', 'c.ts'),
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Runtime inputs
//
// tests/inputs.test.ts already covers the happy path (trimmed stdout, combined
// streams, sorting, the two cwds, non-zero exit, same-project dedup, global
// workspace dedup). What follows is the memo's KEY STRUCTURE — the part that
// decides whether two tasks share a spawn or get their own, which is both a
// correctness question (a project-local probe must see its own project) and the
// reason the workspace variant exists at all.
// ─────────────────────────────────────────────────────────────────────────
describe('runtime input memoization is scoped by design', () => {
  let root: string
  let projA: string
  let projB: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-rt-'))
    projA = path.join(root, 'a')
    projB = path.join(root, 'b')
    await mkdir(projA, { recursive: true })
    await mkdir(projB, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function args(
    projectDir: string,
    inputs: Partial<CacheInputs>,
  ): Parameters<typeof resolveInputs>[0] {
    return {
      projectDir,
      workspaceRoot: root,
      envSource: {} as NodeJS.ProcessEnv,
      inputs: { files: [], ...inputs } as CacheInputs,
      ownOutputs: [],
      nestedProjectDirs: [],
    }
  }

  /** A command that appends one byte per execution — a spawn counter. */
  function counting(file: string): string {
    return `sh -c 'printf x >> ${file}; echo ok'`
  }

  async function spawnCount(file: string): Promise<number> {
    try {
      return (await readFile(file, 'utf8')).length
    } catch {
      return 0
    }
  }

  it('runs the SAME command once per PROJECT, not once per run', async () => {
    // The memo key is `projectDir + '\0' + command`, and it has to be: the
    // command runs IN the project dir, so `cat package.json` or `node -p ...`
    // yields a different answer per project. Sharing one result across projects
    // would fold project A's probe into project B's key — a wrong key that
    // still looks plausible.
    const file = path.join(root, 'per-project')
    const cmd = counting(file)
    const memo = new Map<string, Promise<string>>()
    await resolveInputs({ ...args(projA, { runtime: [cmd] }), runtimeCache: memo })
    await resolveInputs({ ...args(projB, { runtime: [cmd] }), runtimeCache: memo })
    expect(await spawnCount(file)).toBe(2)
  })

  it('the project and workspace memos never share an entry for the same command', async () => {
    // Two separate maps, and additionally a key prefix (`projectDir + '\0'`
    // versus `''`) so intent survives if they were ever merged. The observable
    // consequence is the cwd: the project probe must answer from the project
    // dir and the workspace probe from the root, which is exactly what a
    // collision would break.
    const file = path.join(root, 'both-scopes')
    const cmd = counting(file)
    const got = await resolveInputs({
      ...args(projA, { runtime: [cmd], workspaceRuntime: [cmd] }),
      runtimeCache: new Map<string, Promise<string>>(),
      workspaceRuntimeCache: new Map<string, Promise<string>>(),
    })
    expect(await spawnCount(file)).toBe(2)
    expect(got.runtimeValues).toEqual([[cmd, 'ok']])
    expect(got.workspaceRuntimeValues).toEqual([[cmd, 'ok']])
  })

  it('a command repeated within one list runs once and folds once', async () => {
    // Deduped by the `new Set` before any spawn, so this holds with NO memo
    // passed at all — worth pinning separately from the memo, because the memo
    // is optional and the Set is not. A duplicated entry folding twice would
    // make the key depend on how many times the author listed the command.
    const file = path.join(root, 'dup-in-list')
    const cmd = counting(file)
    const got = await resolveInputs(args(projA, { runtime: [cmd, cmd, cmd] }))
    expect(got.runtimeValues).toEqual([[cmd, 'ok']])
    expect(await spawnCount(file)).toBe(1)
  })

  it('a command producing no output still contributes a pair', async () => {
    // `['true', '']` rather than nothing at all. The pair is what puts the
    // COMMAND into the key, so a silent probe still distinguishes "declared" from
    // "not declared" — dropping empty results would make adding a silent probe
    // a no-op on the key.
    const got = await resolveInputs(args(projA, { runtime: ['true'] }))
    expect(got.runtimeValues).toEqual([['true', '']])
  })

  it('a failing workspaceRuntime command fails the run too, naming the command', async () => {
    // The existing suite covers the project-scope failure. Both scopes route
    // through the same `runRuntimeCommand`, but they are reached by two separate
    // `resolveRuntimeValues` calls inside a `Promise.all` — so a change that
    // swallowed one arm's rejection would leave the other's tests green.
    await expect(
      resolveInputs(args(projA, { workspaceRuntime: ['sh -c "echo nope 1>&2; exit 7"'] })),
    ).rejects.toThrow(/runtime command exited 7/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The gitignore filter direction
// ─────────────────────────────────────────────────────────────────────────
describe('inputs.files can only ever narrow the git file set', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-gitfilter-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    gitInit(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('REFUSES a gitignored file NAMED explicitly in inputs.files', async () => {
    // The candidate set is `git ls-files` output and the user's globs are a
    // FILTER over it. A filter can only remove, so a path git never reported can
    // never be filtered back IN — no matter how explicitly it is named. That
    // made `cache.inputs.files: ['generated.ts']` on a gitignored
    // `generated.ts` resolve to zero files, silently: the task cached on its
    // FIRST run and reported `up-to-date` forever while the file changed
    // underneath it.
    //
    // This test began as a FINDING pinning that silence. Flipping it to assert
    // the refusal is the intended end of that loop.
    await write(path.join(root, '.gitignore'), 'generated.ts\n')
    await write(path.join(projectDir, 'generated.ts'), 'v1')
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')

    const err = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['generated.ts'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toContain('generated.ts')
    expect(err?.message).toContain('contributes NOTHING to the cache key')
    // The remedy has to be named, because the honest answer is not "un-ignore
    // it" for the common case (generated code) — it is to depend on the task
    // that produces it, which is how vx expresses that relationship.
    expect(err?.message).toContain('cache.inputs.tasks')
  })

  it('a BROAD glob over the same tree stays silent — only literals are judged', async () => {
    // The distinction the refusal rests on. A glob matching nothing is
    // legitimate (`src/**/*.gen.ts` in a package with no generated code), so it
    // must not raise; a literal names one exact file, so "matched nothing" is
    // unambiguous. Without this control the refusal could be widened to globs
    // and every optional-file config would start failing.
    await write(path.join(root, '.gitignore'), 'generated.ts\n')
    await write(path.join(projectDir, 'generated.ts'), 'v1')
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')

    const broad = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(broad.files.map((f) => path.relative(projectDir, f))).toEqual([path.join('src', 'a.ts')])
  })

  it('a glob whose own text is ALSO a real filename is still treated as a glob', async () => {
    // The one case where `isLiteralPath` is load-bearing rather than merely
    // cheap, and the reason it exists as a gate at all.
    //
    // Everywhere else the `.exists()` check does the filtering by itself: no
    // file is named `src/**`, so tracking every glob would be wasted work but
    // never a false refusal. Here it would be a false refusal — `a*.ts` is a
    // legal filename on this platform, the file is gitignored, and the glob
    // legitimately matches `ab.ts`. Without the gate the raw pattern text sits
    // in the unmatched set (nothing in the git list equals it verbatim),
    // `exists()` says yes, and a working config is refused.
    //
    // Mutation-verified: making `isLiteralPath` return true for everything is
    // killed by this test and by nothing else in the suite.
    await write(path.join(root, '.gitignore'), 'a*.ts\n')
    await write(path.join(projectDir, 'a*.ts'), 'literally named with a star')
    await write(path.join(projectDir, 'ab.ts'), 'ordinary')

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['a*.ts'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    // `ab.ts` is gitignored by the same pattern, so nothing resolves — but the
    // point is that it RESOLVES rather than throwing.
    expect(got.files).toEqual([])
  })

  it('a literal naming a file that does not exist stays silent', async () => {
    // An ordinary stale declaration, not a stale hit — nothing on disk is being
    // missed. Refusing it would break every config that lists an optional file,
    // so the guard turns on EXISTENCE, not on absence from the git set.
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/a.ts', 'not-here.ts'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual([path.join('src', 'a.ts')])
  })

  it('a literal that git DOES report resolves normally', async () => {
    // The other control: the guard must not fire on the ordinary case of naming
    // a tracked file by hand, which is common (`package.json`, `tsconfig.json`).
    await write(path.join(projectDir, 'tsconfig.json'), '{}')
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['tsconfig.json'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual(['tsconfig.json'])
  })

  it('a task naming its OWN declared output is not refused', async () => {
    // `ownOutputs` are excluded deliberately — a task's output cannot be its own
    // input without the key chasing itself. Those paths ARE in the git set, so
    // they never reach the guard; pinned because a future version that checked
    // the RESOLVED set instead of the git set would start refusing this, and it
    // is a legitimate (if redundant) config.
    await write(path.join(projectDir, 'dist', 'out.js'), 'built')
    await write(path.join(projectDir, 'src', 'a.ts'), 'a')
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/a.ts', 'dist/out.js'] },
      ownOutputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(projectDir, f))).toEqual([path.join('src', 'a.ts')])
  })

  it('the workspace half is refused too, and names its own field', async () => {
    // Second resolver, same filter-over-git-set design, so the hazard is not
    // confined to the project half — this was pinned as a FINDING precisely so
    // a fix would have to address both. The message must name
    // `workspaceFiles`, not `files`: a user staring at a config with both lists
    // needs to know which one to look at.
    await write(path.join(root, '.gitignore'), 'shared-gen.ts\n')
    await write(path.join(root, 'shared-gen.ts'), 'v1')
    await write(path.join(root, 'tsconfig.json'), '{}')

    const err = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['shared-gen.ts', 'tsconfig.json'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toContain('cache.inputs.workspaceFiles')
    expect(err?.message).toContain('shared-gen.ts')
  })

  it('workspaceFiles literals that git DOES report resolve normally', async () => {
    // The control for the workspace half — naming root files by hand is the
    // whole point of the field (a shared tsconfig, a root package.json).
    await write(path.join(root, 'tsconfig.json'), '{}')
    await write(path.join(root, 'package.json'), '{}')
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['tsconfig.json', 'package.json'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(root, f)).sort()).toEqual([
      'package.json',
      'tsconfig.json',
    ])
  })

  it('a declared workspace OUTPUT that is gitignored is not refused as an input', async () => {
    // THIS REPO'S OWN SHAPE, and the false positive that would have hurt most:
    // `build.ui` declares `outputs.workspaceFiles:
    // ['packages/cloud/ui/dist/index.html']`, and `dist` is gitignored. A guard
    // that judged output declarations — or that judged inputs against the
    // RESOLVED set rather than the git set — would refuse this repo's own
    // release build. Outputs are never routed through the input resolver, and
    // this pins that they are not.
    await write(path.join(root, '.gitignore'), 'dist\n')
    await write(path.join(root, 'dist', 'built.js'), 'artifact')
    await write(path.join(root, 'tsconfig.json'), '{}')
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['tsconfig.json'] },
      ownOutputs: [],
      ownWorkspaceOutputs: ['dist/built.js'],
      nestedProjectDirs: [],
    })
    expect(got.files.map((f) => path.relative(root, f))).toEqual(['tsconfig.json'])
  })

  it('declared OUTPUTS are exempt — they are globbed off the live tree, not the git set', async () => {
    // The counterpart that makes the asymmetry deliberate rather than an
    // oversight: `resolveOutputs` uses `Bun.Glob.scan` over the filesystem, so a
    // gitignored `dist/` — the normal case — is captured and restored correctly.
    // Inputs filter the git set; outputs scan the disk. Two different sources,
    // and the finding above is a consequence of that choice.
    await write(path.join(root, '.gitignore'), 'dist\n')
    await write(path.join(projectDir, 'dist', 'bundle.js'), 'built')

    expect(
      await resolveOutputs({ projectDir, outputs: ['dist/**'], nestedProjectDirs: [] }),
    ).toEqual([path.join(projectDir, 'dist', 'bundle.js')])
  })
})
