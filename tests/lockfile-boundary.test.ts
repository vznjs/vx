// Unit tests for `src/workspace/lockfile.ts` — the `vx-lock.json` boundary and
// the frozen-config trust model.
//
// `tests/lock.test.ts` drives `vx lock` end-to-end through the real CLI (three
// tests). This file covers the layer underneath, which is where the rules
// actually live, and it matters for two reasons:
//
//   1. `vx-lock.json` is a COMMITTED, HAND-EDITABLE file. That makes
//      `readLockfile` a system boundary in this codebase's sense — the one
//      place validation is not merely allowed but required. Its own docstring
//      says so. Every rejection there is a message a user reads while their CI
//      is red, so the messages are asserted, not just the throws.
//
//   2. `frozenProjectConfig` implements a deliberate ASYMMETRY that is easy to
//      mistake for a bug and "fix": a `--frozen` run TRUSTS the lock and does
//      no staleness check, while `vx lock --check` audits it by full
//      re-evaluation. The consequence is that a hand-tampered lock IS executed.
//      That is the documented trust model — the 2026-07-26 audit recorded it as
//      sound — so it is pinned here with its reasoning attached.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  frozenProjectConfig,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  lockfilePath,
  readLockfile,
  writeLockfile,
} from '../src/workspace/lockfile.js'
import type { Lockfile } from '../src/workspace/lockfile.js'
import type { ProjectConfig } from '../src/config.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-lockfile-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write raw bytes as the lock, bypassing `writeLockfile`'s shaping. */
async function writeRaw(content: string): Promise<void> {
  await writeFile(lockfilePath(root), content)
}

/**
 * Await a call expected to REJECT and hand back the error. Written as a helper
 * rather than inline `.catch(e => e as Error)` because that widens the result
 * to `Error | <resolved type>` and every message assertion then needs a cast.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection, but the call resolved')
}

const CONFIG: ProjectConfig = { tasks: { build: { exec: { command: 'echo hi' } } } }

function lock(over: Partial<Lockfile> = {}): Lockfile {
  return {
    version: LOCKFILE_VERSION,
    projects: {
      pkg: { configPath: 'pkg/vx.config.ts', configHash: 'abc123', config: CONFIG },
    },
    ...over,
  }
}

describe('lockfilePath', () => {
  it('is vx-lock.json at the workspace root', () => {
    // The name is part of the user contract — it is committed, it appears in
    // .gitignore discussions, and `--frozen` error messages tell people to
    // delete it by name.
    expect(lockfilePath(root)).toBe(path.join(root, 'vx-lock.json'))
    expect(LOCKFILE_NAME).toBe('vx-lock.json')
  })
})

describe('readLockfile — absent is not an error', () => {
  it('returns null when there is no lock', async () => {
    // The feature is opt-in, so the overwhelmingly common case is "no lock".
    // If this ever threw, every plain `vx run` in every workspace would fail.
    expect(await readLockfile(root)).toBeNull()
  })
})

describe('readLockfile — the boundary rejects malformed input loudly', () => {
  // Each case asserts the MESSAGE, not just that something threw. A lockfile
  // error surfaces while someone's build is broken, and the whole value of
  // validating here rather than crashing deeper in the run is that the message
  // names the file and the fix.

  it('rejects content that is not JSON at all', async () => {
    // The realistic cause is a merge conflict: `<<<<<<< HEAD` in a committed
    // file. Without this the failure would surface as a parse error from
    // somewhere inside config loading.
    await writeRaw('{ not json')
    await expect(readLockfile(root)).rejects.toThrow(/not valid JSON/)
    await expect(readLockfile(root)).rejects.toThrow(/vx lock/)
  })

  it.each([
    ['a string', '"nope"'],
    ['a number', '42'],
    ['null', 'null'],
    ['a boolean', 'true'],
  ])('rejects valid JSON that is %s rather than an object', async (_label, raw) => {
    // `typeof null === 'object'` is the classic hole here, so null is checked
    // explicitly alongside the scalars. An ARRAY is the case this guard does
    // NOT catch — see the finding below.
    await writeRaw(raw)
    await expect(readLockfile(root)).rejects.toThrow(/must be a JSON object/)
  })

  it('FINDING: a top-level ARRAY misreports as a version error', async () => {
    // `typeof [] === 'object'` and it is not null, so an array passes the
    // shape guard and falls through to the VERSION check, which reads
    // `[].version` as undefined and reports:
    //
    //   vx-lock.json has unsupported version undefined (this vx expects 1)
    //
    // The failure is safe — it is still a UserError naming the file and
    // telling the reader to re-run `vx lock` — but the message misdirects: it
    // sends someone hunting a version-compatibility problem when the file is
    // simply not the right shape. Same root cause as the `projects` case
    // below: `readLockfile` has no `Array.isArray` guard anywhere, while the
    // loader one layer down has one explicitly.
    //
    // Pinned as current behaviour so the wrong message is visible rather than
    // merely present.
    await writeRaw('[]')
    await expect(readLockfile(root)).rejects.toThrow(/unsupported version undefined/)
  })

  it.each([
    ['an older version', 0],
    ['a newer version', LOCKFILE_VERSION + 1],
    ['a string version', '1'],
    ['null', null],
  ])('rejects %s and names both versions', async (_label, version) => {
    // A version mismatch must say what it found AND what this vx expects —
    // otherwise the reader cannot tell whether to upgrade vx or re-lock. The
    // string case matters because `'1' !== 1`: a hand-edited or
    // YAML-round-tripped lock can easily stringify the number.
    await writeRaw(JSON.stringify({ version, projects: {} }))
    const err = await rejection(readLockfile(root))
    expect(err.message).toContain(String(version))
    expect(err.message).toContain(String(LOCKFILE_VERSION))
  })

  it('rejects a lock with no version field', async () => {
    await writeRaw(JSON.stringify({ projects: {} }))
    await expect(readLockfile(root)).rejects.toThrow(/unsupported version/)
  })

  it.each([
    ['missing', JSON.stringify({ version: LOCKFILE_VERSION })],
    ['null', JSON.stringify({ version: LOCKFILE_VERSION, projects: null })],
    ['a string', JSON.stringify({ version: LOCKFILE_VERSION, projects: 'pkg' })],
    ['a number', JSON.stringify({ version: LOCKFILE_VERSION, projects: 3 })],
  ])('rejects a `projects` field that is %s', async (_label, raw) => {
    await writeRaw(raw)
    await expect(readLockfile(root)).rejects.toThrow(/`projects` must be an object/)
  })

  it.each([
    ['null', null],
    ['a string', 'pkg/vx.config.ts'],
    ['missing configPath', { configHash: 'h', config: {} }],
    ['missing configHash', { configPath: 'p', config: {} }],
    ['missing config', { configPath: 'p', configHash: 'h' }],
    ['a null config', { configPath: 'p', configHash: 'h', config: null }],
    ['a non-object config', { configPath: 'p', configHash: 'h', config: 'nope' }],
    ['a numeric configHash', { configPath: 'p', configHash: 42, config: {} }],
  ])('rejects an entry that is %s, naming the project', async (_label, entry) => {
    // Naming the project is the point: a monorepo lock has hundreds of
    // entries, and "something is malformed" without a name is unactionable.
    await writeRaw(JSON.stringify({ version: LOCKFILE_VERSION, projects: { '@acme/api': entry } }))
    await expect(readLockfile(root)).rejects.toThrow(/@acme\/api/)
    await expect(readLockfile(root)).rejects.toThrow(/malformed/)
  })

  it('accepts a well-formed lock and round-trips it', async () => {
    // The control for every rejection above: without this, a validator that
    // rejected EVERYTHING would still pass the whole block.
    await writeLockfile(root, lock())
    const read = await readLockfile(root)
    expect(read).not.toBeNull()
    expect(read?.version).toBe(LOCKFILE_VERSION)
    expect(read?.projects['pkg']?.config).toEqual(CONFIG)
  })

  it('accepts an empty projects map', async () => {
    // A workspace whose projects all declare no config is degenerate but
    // legal; it must not read as corruption.
    await writeLockfile(root, { version: LOCKFILE_VERSION, projects: {} })
    expect((await readLockfile(root))?.projects).toEqual({})
  })

  it('FINDING: a `projects` ARRAY passes the object guard', async () => {
    // `typeof [] === 'object'` and it is not null, so an array slips through
    // the `projects` check — `Object.entries` then yields entries keyed "0",
    // "1", … and a lock shaped `projects: [ {...} ]` validates as a project
    // literally NAMED "0".
    //
    // This is the same class the loader explicitly guards against one layer
    // down: `validateProjectConfig` rejects an array `tasks` with a comment
    // about "a task literally named 0". The `projects` guard here has no
    // matching `Array.isArray` check.
    //
    // Impact is low — nothing generates this shape, and a project named "0"
    // simply never matches a real project, so the run fails later at
    // `frozenProjectConfig` with a clear "no entry for X" message rather than
    // running the wrong thing. Pinned as current behaviour, not endorsed: the
    // consistent fix is an `Array.isArray` guard beside the existing one.
    await writeRaw(
      JSON.stringify({
        version: LOCKFILE_VERSION,
        projects: [{ configPath: 'p', configHash: 'h', config: CONFIG }],
      }),
    )
    const read = await readLockfile(root)
    expect(Array.isArray(read?.projects)).toBe(true)
    // …and the degradation is at least honest: the bogus "0" entry cannot
    // satisfy a real project's lookup.
    await expect(
      frozenProjectConfig(read as Lockfile, { name: 'pkg', configPath: `${root}/p` }, root),
    ).rejects.toThrow(/has no entry for "pkg"/)
  })
})

describe('writeLockfile — the file is committed, so its shape is a contract', () => {
  it('writes 2-space-indented JSON with a trailing newline', async () => {
    // The lock is committed and reviewed. Minified JSON would make every
    // change a single unreadable diff line, and a missing trailing newline
    // makes git and POSIX tools complain on every write.
    await writeLockfile(root, lock())
    const text = await Bun.file(lockfilePath(root)).text()
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "version": 1')
  })

  it('overwrites rather than merging', async () => {
    // `vx lock` re-freezes the whole workspace; a stale project left behind
    // from a previous lock would be executed by a later `--frozen` run.
    await writeLockfile(root, {
      version: LOCKFILE_VERSION,
      projects: { old: { configPath: 'old/vx.config.ts', configHash: 'h', config: CONFIG } },
    })
    await writeLockfile(root, lock())
    const read = await readLockfile(root)
    expect(Object.keys(read?.projects ?? {})).toEqual(['pkg'])
  })
})

describe('frozenProjectConfig — the trust model', () => {
  const meta = { name: 'pkg', configPath: '' }

  function metaFor(rel: string): { name: string; configPath: string } {
    return { ...meta, configPath: path.join(root, rel) }
  }

  it('returns the frozen config for a locked project', async () => {
    const cfg = await frozenProjectConfig(lock(), metaFor('pkg/vx.config.ts'), root)
    expect(cfg).toEqual(CONFIG)
  })

  it('refuses a project the lock does not know, naming it and the fix', async () => {
    // The ADDED-PROJECT case: someone creates a package and runs CI without
    // re-locking. Silently evaluating it would defeat frozen-env semantics, so
    // this is a hard error — and it must say which project and what to do.
    const err = await rejection(frozenProjectConfig(lock(), metaFor('other/vx.config.ts'), root))
    expect(err.message).toContain('"pkg"')
    expect(err.message).toContain('other/vx.config.ts')
    expect(err.message).toContain('vx lock')
  })

  it('refuses when the entry points at a DIFFERENT config path', async () => {
    // The MOVED/RENAMED case. The lock is keyed by project name, so a package
    // that moved directories still finds its entry by name — and the stored
    // config would be applied to the wrong file. Comparing the path is what
    // catches it.
    const moved = lock({
      projects: {
        pkg: { configPath: 'somewhere/else/vx.config.ts', configHash: 'h', config: CONFIG },
      },
    })
    await expect(frozenProjectConfig(moved, metaFor('pkg/vx.config.ts'), root)).rejects.toThrow(
      /has no entry for "pkg"/,
    )
  })

  // NOT TESTED, deliberately: that the path comparison normalizes to POSIX so
  // a lock committed on one platform resolves on another. `relPosix` is
  // `toPosix(path.relative(...))`, and on Linux `path.relative` ALREADY
  // returns POSIX separators — so `toPosix` is the identity here and any
  // assertion passes whether or not the normalization exists. Verified: a
  // mutation replacing `relPosix` with a bare `path.relative` kills nothing.
  //
  // The same hazard is recorded against `toPosix` itself in
  // tests/util-paths.test.ts. A real guard needs a Windows runner (or an
  // injected path module), so this is a known coverage gap rather than a
  // silent one — recorded here so nobody re-adds the passing-both-ways
  // version believing it covers the case.

  it('DELIBERATE: a hand-tampered stored config IS executed', async () => {
    // The asymmetry, stated as a test so nobody "fixes" it by accident.
    //
    // A `--frozen` run does NO staleness check — not even the configHash the
    // entry carries. That is on purpose and the reasoning is written at the
    // call site: `vx lock --check` re-evaluates everything, so a byte-hash
    // re-check here would be redundant work AND a weaker guarantee pretending
    // to add safety (a file hash cannot see a config's IMPORT CLOSURE or its
    // env reads, which is the drift that actually matters).
    //
    // So the lock is trusted exactly as far as the repo it lives in is
    // trusted, and `--check` is the audit. Anyone tightening this should
    // change `--check`, not this path.
    const tampered = lock({
      projects: {
        pkg: {
          configPath: 'pkg/vx.config.ts',
          configHash: 'abc123',
          config: { tasks: { build: { exec: { command: 'echo TAMPERED' } } } },
        },
      },
    })
    const cfg = await frozenProjectConfig(tampered, metaFor('pkg/vx.config.ts'), root)
    expect(cfg.tasks?.['build']?.exec?.command).toBe('echo TAMPERED')
  })

  it('DELIBERATE: a configHash that no longer matches anything is not consulted', async () => {
    // The same decision from the other side. `configHash` remains in the file
    // solely so `vx lock --check` can report "this file changed" quickly. A
    // run never reads it, so an obviously-wrong value changes nothing.
    const stale = lock({
      projects: {
        pkg: { configPath: 'pkg/vx.config.ts', configHash: 'not-a-real-hash', config: CONFIG },
      },
    })
    expect(await frozenProjectConfig(stale, metaFor('pkg/vx.config.ts'), root)).toEqual(CONFIG)
  })

  it('still validates the stored config, so a lock cannot inject a broken shape', async () => {
    // Trust does not mean unchecked. The stored object crosses the same
    // boundary a freshly evaluated one does, so a lock carrying a structurally
    // invalid config fails with the SAME message a bad vx.config.ts would give
    // — and the message names the lockfile so the reader knows where to look.
    const broken = lock({
      projects: {
        pkg: {
          configPath: 'pkg/vx.config.ts',
          configHash: 'h',
          config: { tasks: [{ exec: { command: 'x' } }] } as unknown as ProjectConfig,
        },
      },
    })
    const err = await rejection(frozenProjectConfig(broken, metaFor('pkg/vx.config.ts'), root))
    expect(err.message).toContain(LOCKFILE_NAME)
    expect(err.message).toContain('pkg')
    expect(err.message).toMatch(/`tasks` must be an object/)
  })

  it('accepts a locked project that declares no tasks', async () => {
    // A config with no `tasks` is legal (validation returns early), so the
    // frozen path must not invent a requirement the live loader does not have.
    const empty = lock({
      projects: {
        pkg: { configPath: 'pkg/vx.config.ts', configHash: 'h', config: {} },
      },
    })
    expect(await frozenProjectConfig(empty, metaFor('pkg/vx.config.ts'), root)).toEqual({})
  })
})
