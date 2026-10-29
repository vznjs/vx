// Unit tests for `src/workspace/lockfile.ts` — the `.vx/projects.lock.json` boundary and
// the frozen-config trust model.
//
// `tests/lock.test.ts` drives `vx lock` end-to-end through the real CLI (three
// tests). This file covers the layer underneath, which is where the rules
// actually live, and it matters for two reasons:
//
//   1. `.vx/projects.lock.json` is a COMMITTED, HAND-EDITABLE file. That makes
//      `readLockfile` a system boundary in this codebase's sense — the one
//      place validation is not merely allowed but required. Its own docstring
//      says so. Every rejection there is a message a user reads while their CI
//      is red, so the messages are asserted, not just the throws.
//
//   2. `frozenProjectConfig` implements a deliberate ASYMMETRY that is easy to
//      mistake for a bug and "fix": every run TRUSTS the lock and does no
//      staleness check, while `vx lock --check` audits it by full
//      re-evaluation, and a run validates no entry either. The consequence is
//      that a hand-tampered lock IS executed.
//      That is the documented trust model — the 2026-07-26 audit recorded it as
//      sound — so it is pinned here with its reasoning attached.

import { link, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  frozenProjectConfigs,
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
  await Bun.write(lockfilePath(root), content)
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

/** A lock entry: the directory's config file and its resolved config. */
const entry = (config: ProjectConfig) => ({ file: 'vx.config.ts' as const, config })

/** One project's frozen config, as a run of one would load it. */
async function frozenProjectConfig(
  l: Lockfile,
  meta: { name: string; dir: string; configPath: string },
  r: string,
): Promise<ProjectConfig> {
  return frozenProjectConfigs(l, [meta], r)[0]!
}

function lock(over: Partial<Lockfile> = {}): Lockfile {
  return {
    version: LOCKFILE_VERSION,
    projects: { pkg: entry(CONFIG) },
    ...over,
  }
}

describe('lockfilePath', () => {
  it('is .vx/projects.lock.json at the workspace root', () => {
    // The name is part of the user contract — it is committed, it appears in
    // .gitignore discussions, and a run's refusals name it.
    expect(lockfilePath(root)).toBe(path.join(root, '.vx/projects.lock.json'))
    expect(LOCKFILE_NAME).toBe('.vx/projects.lock.json')
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

  it('a top-level ARRAY is a SHAPE error, not a misreported version error', async () => {
    // `typeof [] === 'object'` and it is not null, so an array used to pass the
    // shape guard and fall through to the VERSION check, which read
    // `[].version` as undefined and reported "unsupported version undefined".
    //
    // Safe — still a UserError naming the file — but it MISDIRECTS, sending a
    // reader after a version-compatibility problem when the file is simply the
    // wrong shape. This file is committed and hand-editable, so its messages
    // are read while CI is red; a wrong one costs real time.
    await writeRaw('[]')
    await expect(readLockfile(root)).rejects.toThrow(/must be a JSON object/)
  })

  it.each([
    ['an older version', 0],
    ['a newer version', LOCKFILE_VERSION + 1],
    ['a string version', '2'],
    ['the version before entries were bare configs', 1],
    ['the version that keyed projects by name', 2],
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
    ['a number', 42],
    ['an array', [CONFIG]],
    ['a bare config, as version 2 wrote', CONFIG],
    ['a file that is no vx.config', { file: 'package.json', config: {} }],
    ['a config that is no object', { file: 'vx.config.ts', config: [] }],
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
    expect(read?.projects['pkg']).toEqual(entry(CONFIG))
  })

  it('accepts an empty projects map', async () => {
    // A workspace whose projects all declare no config is degenerate but
    // legal; it must not read as corruption.
    await writeLockfile(root, { version: LOCKFILE_VERSION, projects: {} })
    expect((await readLockfile(root))?.projects).toEqual({})
  })

  it('a `projects` ARRAY is refused rather than yielding a project named "0"', async () => {
    // `typeof [] === 'object'` and it is not null, so an array used to slip
    // through the `projects` check — `Object.entries` then yields entries keyed
    // "0", "1", … and a lock shaped `projects: [ {...} ]` validated as a project
    // literally NAMED "0".
    //
    // The loader explicitly guards this same class one layer down:
    // `validateProjectConfig` rejects an array `tasks` with a comment about "a
    // task literally named 0". The omission here was an inconsistency, not a
    // considered difference.
    //
    // The old degradation was at least honest — a bogus "0" entry cannot satisfy
    // a real lookup, so a run failed later at `frozenProjectConfig`
    // with "has no entry for X" — but it named the wrong thing: the file was
    // malformed, not missing an entry. Refusing at the boundary says so.
    await writeRaw(
      JSON.stringify({
        version: LOCKFILE_VERSION,
        projects: [CONFIG],
      }),
    )
    await expect(readLockfile(root)).rejects.toThrow(/`projects` must be an object/)
  })

  it('a directory key outside the root, or not as vx lock spells one, is refused', async () => {
    // A run joined `../evil` onto the root and ran a project outside the
    // workspace; `/tmp` read as a project `tmp` at `<root>/tmp`.
    for (const dir of ['../evil', 'a/../../x', '/tmp', 'a/', './a', 'a//b', '']) {
      await writeRaw(
        JSON.stringify({ version: LOCKFILE_VERSION, projects: { [dir]: entry(CONFIG) } }),
      )
      expect((await rejection(readLockfile(root))).message).toBe(
        `${LOCKFILE_NAME}: "${dir}" is not a directory under the workspace root — re-run \`vx lock\``,
      )
    }
    for (const dir of ['.', 'a', 'a/b', '.github/actions/x', 'a..b']) {
      await writeRaw(
        JSON.stringify({ version: LOCKFILE_VERSION, projects: { [dir]: entry(CONFIG) } }),
      )
      expect(Object.keys((await readLockfile(root))!.projects)).toEqual([dir])
    }
  })
})

describe('writeLockfile — the file is committed, so its shape is a contract', () => {
  it('writes minified JSON with a trailing newline', async () => {
    // The lock is the one file a run reads, and minified loads faster; the
    // per-project `vx.lock.json` copies are what a reviewer reads. A missing
    // trailing newline makes git and POSIX tools complain on every write.
    await writeLockfile(root, lock())
    const text = await Bun.file(lockfilePath(root)).text()
    expect(text).toBe(`${JSON.stringify(JSON.parse(text))}\n`)
    expect(text.startsWith(`{"version":${LOCKFILE_VERSION},`)).toBe(true)
  })

  // 2026-10-25: a key hashes a task's config JSON, so moving `cache` above
  // `exec`, or listing a define in another order, missed every key.
  it("sorts each task's keys, keeping the tasks in their order", async () => {
    const write = async (tasks: NonNullable<ProjectConfig['tasks']>) => {
      await writeLockfile(root, { version: LOCKFILE_VERSION, projects: { pkg: entry({ tasks }) } })
      return Bun.file(lockfilePath(root)).text()
    }
    const a = await write({
      z: { exec: { command: 'x', env: { define: { A: '1', B: '2' } } }, inputs: { files: [] } },
      a: { exec: { command: 'y' } },
    })
    const b = await write({
      z: { inputs: { files: [] }, exec: { env: { define: { B: '2', A: '1' } }, command: 'x' } },
      a: { exec: { command: 'y' } },
    })
    expect(b).toBe(a)
    expect(Object.keys((await readLockfile(root))!.projects['pkg']!.config.tasks!)).toEqual([
      'z',
      'a',
    ])
  })

  it('overwrites rather than merging', async () => {
    // `vx lock` re-freezes the whole workspace; a stale project left behind
    // from a previous lock would be executed by a later run.
    await writeLockfile(root, {
      version: LOCKFILE_VERSION,
      projects: { old: entry(CONFIG) },
    })
    await writeLockfile(root, lock())
    const read = await readLockfile(root)
    expect(Object.keys(read?.projects ?? {})).toEqual(['pkg'])
  })

  it('replaces the file by rename, never rewriting it in place (item 972)', async () => {
    // A write in place truncates first, and a run reading in between
    // reads an empty lock. The inode says which happened: a second name
    // hard-linked to the old lock keeps the old bytes only when the lock
    // was replaced, and nothing but the lock is left in the directory.
    await writeLockfile(root, { version: LOCKFILE_VERSION, projects: {} })
    const before = await Bun.file(lockfilePath(root)).text()
    const other = path.join(root, 'other.json')
    await link(lockfilePath(root), other)
    await writeLockfile(root, lock())
    expect(await Bun.file(other).text()).toBe(before)
    expect(Object.keys((await readLockfile(root))?.projects ?? {})).toEqual(['pkg'])
    expect((await readdir(root)).sort()).toEqual(['.vx', 'other.json'])
    expect(await readdir(path.join(root, '.vx'))).toEqual(['projects.lock.json'])
  })

  it('a rename that fails leaves no temp behind and rejects (item 972)', async () => {
    // A directory where the lock goes: the rename onto it fails.
    await mkdir(path.join(lockfilePath(root), 'x'), { recursive: true })
    await expect(writeLockfile(root, lock())).rejects.toThrow()
    expect(await readdir(path.join(root, '.vx'))).toEqual(['projects.lock.json'])
  })

  it('a refused write names .vx/projects.lock.json, not its temp (item 972)', async () => {
    // What a read-only checkout prints comes from this message. A root run
    // is refused no write for permissions, and `Bun.write` makes a missing
    // directory, so a FILE where the root should be stands in for it.
    const gone = path.join(root, 'gone')
    await writeFile(gone, '')
    const err = await writeLockfile(gone, lock()).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    )
    expect({ code: err?.code, path: err?.path }).toEqual({
      code: 'ENOTDIR',
      path: lockfilePath(gone),
    })
    expect(err?.message).toBe(`ENOTDIR: not a directory, open '${lockfilePath(gone)}'`)
  })
})

describe('frozenProjectConfig — the trust model', () => {
  function metaFor(rel: string): { name: string; dir: string; configPath: string } {
    const configPath = path.join(root, rel)
    return { name: 'pkg', dir: path.dirname(configPath), configPath }
  }

  it('returns the frozen config for a locked project', async () => {
    const cfg = await frozenProjectConfig(lock(), metaFor('pkg/vx.config.ts'), root)
    expect(cfg).toEqual(CONFIG)
  })

  it('refuses a project the lock does not know, naming it and the fix', async () => {
    // The ADDED-PROJECT case: someone creates a package and runs CI without
    // re-locking. Silently evaluating it would defeat frozen-env semantics, so
    // this is a hard error — and it must say which project and what to do.
    const err = await rejection(
      frozenProjectConfig(
        lock(),
        {
          name: 'other',
          dir: path.join(root, 'other'),
          configPath: path.join(root, 'other/vx.config.ts'),
        },
        root,
      ),
    )
    expect(err.message).toContain('"other"')
    expect(err.message).toContain('other/vx.config.ts')
    expect(err.message).toContain('vx lock')
  })

  it('a directory named like an Object.prototype member has no entry by inheritance (D-152)', async () => {
    // `lock.projects.constructor` is Object's own constructor: the lock
    // "locked" the project at undefined, and the refusal said it had moved.
    for (const name of ['constructor', 'toString', '__proto__']) {
      const dir = path.join(root, name)
      const err = await rejection(
        frozenProjectConfig(
          lock(),
          { name, dir, configPath: path.join(dir, 'vx.config.ts') },
          root,
        ),
      )
      expect(err.message).toBe(
        `.vx/projects.lock.json has no entry for "${name}" (${name}/vx.config.ts) — run \`vx lock\``,
      )
    }
  })

  // NOT TESTED, deliberately: that the refusal's path is POSIX on every
  // platform. `relPosix` is
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
    // A run does NO staleness check. That is on purpose:
    // `vx lock --check` re-evaluates everything, so a byte-hash re-check here
    // would be redundant work AND a weaker guarantee pretending to add safety
    // (a file hash cannot see a config's IMPORT CLOSURE or its env reads,
    // which is the drift that actually matters).
    //
    // So the lock is trusted exactly as far as the repo it lives in is
    // trusted, and `--check` is the audit. Anyone tightening this should
    // change `--check`, not this path.
    const tampered = lock({
      projects: { pkg: entry({ tasks: { build: { exec: { command: 'echo TAMPERED' } } } }) },
    })
    const cfg = await frozenProjectConfig(tampered, metaFor('pkg/vx.config.ts'), root)
    expect(cfg.tasks?.['build']?.exec?.command).toBe('echo TAMPERED')
  })

  it('DELIBERATE: a run validates no entry, whatever the stamp says', async () => {
    // `vx lock` validated every entry it wrote and `vx lock --check`
    // re-evaluates them; a run only parses the JSON shape (owner,
    // 2026-10-14). A broken entry an edit left is the audit's to catch.
    const shape = { tasks: [{ exec: { command: 'x' } }] } as unknown as ProjectConfig
    await writeRaw(JSON.stringify(lock({ projects: { pkg: entry(shape) } })))
    const read = (await readLockfile(root))!
    expect(await frozenProjectConfig(read, metaFor('pkg/vx.config.ts'), root)).toEqual(shape)
  })

  it('accepts a locked project that declares no tasks', async () => {
    // A config with no `tasks` is legal (validation returns early), so the
    // frozen path must not invent a requirement the live loader does not have.
    const empty = lock({
      projects: { pkg: entry({}) },
    })
    expect(await frozenProjectConfig(empty, metaFor('pkg/vx.config.ts'), root)).toEqual({})
  })
})

describe("the lock's validated stamp", () => {
  it('is the last field, written once when a read lock is written back', async () => {
    await writeLockfile(root, lock())
    await writeLockfile(root, (await readLockfile(root))!)
    const text = await Bun.file(lockfilePath(root)).text()
    expect(text.match(/"validated"/g)?.length).toBe(1)
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'projects', 'validated'])
  })
})
