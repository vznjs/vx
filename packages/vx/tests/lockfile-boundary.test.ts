// Unit tests for `src/workspace/lockfile.ts` — the `.vx/projects.lock` boundary and
// the frozen-config trust model.
//
// `tests/lock.test.ts` drives `vx lock` end-to-end through the real CLI (three
// tests). This file covers the layer underneath, which is where the rules
// actually live, and it matters for two reasons:
//
//   1. `.vx/projects.lock` is a COMMITTED, HAND-EDITABLE file. That makes
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
  lockEntryBroken,
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

/** A lock entry: the project's name, its config file and its resolved config. */
const entry = (config: ProjectConfig, name = 'pkg') => ({
  name,
  file: 'vx.config.ts' as const,
  config,
})

/** A lock's lines as `vx lock` lays them out: the header, then one line each. */
const jsonl = (...lines: string[]) =>
  `${[JSON.stringify({ version: LOCKFILE_VERSION }), ...lines].join('\n')}\n`

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
  it('is .vx/projects.lock at the workspace root', () => {
    // The name is part of the user contract — it is committed, it appears in
    // .gitignore discussions, and a run's refusals name it.
    expect(lockfilePath(root)).toBe(path.join(root, '.vx/projects.lock'))
    expect(LOCKFILE_NAME).toBe('.vx/projects.lock')
  })
})

describe('readLockfile — absent is not an error', () => {
  it('returns null when there is no lock', async () => {
    // The feature is opt-in, so the overwhelmingly common case is "no lock".
    // If this ever threw, every plain `vx run` in every workspace would fail.
    expect(await readLockfile(root)).toBeNull()
  })

  it('no lock is no broken entry, so a crash before the first `vx lock` stays itself', () => {
    // It read as broken: any crash in a fresh workspace, `vx lock`'s own
    // included, printed "projects.lock is invalid, run `vx lock`" in its place.
    expect(lockEntryBroken(root)).toBe(false)
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

  it('a conflict on the first line is a merge conflict, not bad JSON', async () => {
    // Two branches that each bumped the lock's version conflict on its header:
    // the run said "not valid JSON — delete it" instead of naming the merge.
    await writeRaw('<<<<<<< HEAD\n{"version":9}\n=======\n{"version":8}\n>>>>>>> other\n')
    await expect(readLockfile(root)).rejects.toThrow(/holds a git merge conflict/)
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
    await expect(readLockfile(root)).rejects.toThrow(/must start with a JSON object/)
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
    await expect(readLockfile(root)).rejects.toThrow(/must start with a JSON object/)
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

  it('a lock a newer vx wrote says to upgrade vx, not to re-lock', async () => {
    // Re-running this vx's `vx lock` would write the older version over it.
    await writeRaw(JSON.stringify({ version: LOCKFILE_VERSION + 1, projects: {} }))
    const err = await rejection(readLockfile(root))
    expect(err.message).toBe(
      `.vx/projects.lock was written by a newer vx (version ${LOCKFILE_VERSION + 1}; this vx reads ${LOCKFILE_VERSION}) — upgrade vx`,
    )
  })

  it('rejects a lock with no version field', async () => {
    await writeRaw(JSON.stringify({ projects: {} }))
    await expect(readLockfile(root)).rejects.toThrow(/unsupported version/)
  })

  // A merge that kept both sides, or a hand edit that lost a tab: a line
  // `vx lock` never writes says so, never a raw crash at a lookup.
  it.each([
    ['a line with no tab', jsonl('pkg {"path":"pkg"}')],
    [
      'two lines of one name',
      jsonl('pkg\t{"path":"a","file":null}', 'pkg\t{"path":"b","file":null}'),
    ],
    ['an entry that is no object', jsonl('pkg\tnull')],
    ['an entry that is a list', jsonl('pkg\t[]')],
    ['an empty name', jsonl('\t{"path":"pkg"}')],
  ])('rejects %s', async (_label, raw) => {
    await writeRaw(raw)
    await expect(readLockfile(root)).rejects.toThrow(/holds a line `vx lock` never writes/)
  })

  it.each([
    ['a bare config, as version 2 wrote', { tasks: {} }],
    ['a file that is no vx.config', { file: 'package.json', config: {} }],
    ['a file with no config', { file: 'vx.config.ts' }],
    ['a config that is no object', { file: 'vx.config.ts', config: [] }],
    // Hand edits a run read as something else: a string `tasks` counted as
    // two tasks, and a number `name` ran silently.
    ['a name that is no string', { file: 'vx.config.ts', config: { name: 5 } }],
    ['tags that are no list', { file: 'vx.config.ts', config: { tags: 'web' } }],
    ['tasks that are no object', { file: 'vx.config.ts', config: { tasks: 'x' } }],
    ['a task that is no task line', { file: 'vx.config.ts', config: { tasks: { b: 'echo' } } }],
  ])('rejects an entry that is %s, naming the project', async (_label, entry) => {
    // Naming the project is the point: a monorepo lock has hundreds of
    // entries, and "something is malformed" without a name is unactionable.
    await writeRaw(jsonl(`@acme/api\t${JSON.stringify({ path: 'api', ...entry })}`))
    await expect(readLockfile(root)).rejects.toThrow('entry for "api" is malformed')
  })

  it('a string dependsOn is refused, not walked per character ("dependsOn b#a")', async () => {
    await writeRaw(jsonl('pkg\t{"path":"pkg"}', '#ttttttt', '{"dependsOn":"a#build"}', '\tb'))
    await expect(readLockfile(root)).rejects.toThrow('entry for "pkg" is malformed')
  })

  it('a task line no entry has refuses, naming it', async () => {
    await writeRaw(jsonl('pkg\t{"path":"pkg"}', '#goneaaa', '\tb'))
    await expect(readLockfile(root)).rejects.toThrow('no task #goneaaa')
    // What a crash path reads to tell "re-run `vx lock`" from a vx bug.
    expect(lockEntryBroken(root)).toBe(true)
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

  it('a directory key outside the root, or not as vx lock spells one, is refused', async () => {
    // A run joined `../evil` onto the root and ran a project outside the
    // workspace; `/tmp` read as a project `tmp` at `<root>/tmp`.
    for (const dir of ['../evil', 'a/../../x', '/tmp', 'a/', './a', 'a//b', '']) {
      await writeRaw(jsonl(`pkg\t${JSON.stringify({ path: dir, file: null })}`))
      expect((await rejection(readLockfile(root))).message).toBe(
        `${LOCKFILE_NAME}: "${dir}" is not a directory under the workspace root — re-run \`vx lock\``,
      )
    }
    for (const dir of ['.', 'a', 'a/b', '.github/actions/x', 'a..b']) {
      await writeRaw(jsonl(`pkg\t${JSON.stringify({ path: dir, file: null })}`))
      expect(Object.keys((await readLockfile(root))!.projects)).toEqual([dir])
    }
  })
})

describe('writeLockfile — the file is committed, so its shape is a contract', () => {
  it('writes a header, then each project with its tasks by pointer, each JSON once', async () => {
    // Each project, in name-hash order, lists its tasks as a name line and
    // a pointer line; a task two projects declare alike has its JSON once,
    // under its first holder; `vx.config.ts` is the file a line leaves out.
    // A missing trailing newline makes git complain on every write.
    const build = { exec: { command: 'echo hi' } }
    await writeLockfile(root, {
      version: LOCKFILE_VERSION,
      projects: {
        web: entry({ tasks: { build } }, 'web'),
        api: entry({ name: 'api', tasks: { build } }, 'api'),
        docs: { name: 'docs', by: '@vzn/vx-migrate' },
      },
    })
    const id = `#${Bun.hash.xxHash3(JSON.stringify(build)).toString(36).padStart(7, '0').slice(0, 7)}`
    const lines: Record<string, string> = {
      api: `api\t{"path":"api","config":{"name":"api"}}\n${id}\n\tbuild\n`,
      docs: 'docs\t{"path":"docs","by":"@vzn/vx-migrate"}\n',
      web: `web\t{"path":"web"}\n${id}\n\tbuild\n`,
    }
    const order = Object.keys(lines).sort((a, b) =>
      Bun.hash.xxHash3(a) < Bun.hash.xxHash3(b) ? -1 : 1,
    )
    const first = order.find((n) => n !== 'docs')!
    lines[first] = lines[first]!.replace(`${id}\n`, `${id}\n{"exec":{"command":"echo hi"}}\n`)
    expect(await Bun.file(lockfilePath(root)).text()).toBe(
      `{"version":${LOCKFILE_VERSION}}\n` + order.map((n) => lines[n]).join(''),
    )
    const read = (await readLockfile(root))!
    expect(read.projects['web']!.config!.tasks!['build']).toBe(
      read.projects['api']!.config!.tasks!['build'],
    )
  })

  it('a name a tab or another line could break reads back', async () => {
    const names = ['a\tb', '#x', '"q', '{y']
    await writeLockfile(root, {
      version: LOCKFILE_VERSION,
      projects: Object.fromEntries(names.map((n, i) => [`p${i}`, entry(CONFIG, n)])),
    })
    const read = (await readLockfile(root))!
    expect(
      Object.values(read.projects)
        .map((p) => p.name)
        .sort(),
    ).toEqual([...names].sort())
  })

  // 2026-10-25: a key hashes a task's config JSON, so moving `cache` above
  // `exec`, or listing a define in another order, missed every key.
  it("sorts each task's keys, and the tasks by name", async () => {
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
    expect(Object.keys((await readLockfile(root))!.projects['pkg']!.config!.tasks!)).toEqual([
      'a',
      'z',
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
    expect(await readdir(path.join(root, '.vx'))).toEqual(['projects.lock'])
  })

  it('a rename that fails leaves no temp behind and rejects (item 972)', async () => {
    // A directory where the lock goes: the rename onto it fails.
    await mkdir(path.join(lockfilePath(root), 'x'), { recursive: true })
    await expect(writeLockfile(root, lock())).rejects.toThrow()
    expect(await readdir(path.join(root, '.vx'))).toEqual(['projects.lock'])
  })

  it('a refused write names .vx/projects.lock, not its temp (item 972)', async () => {
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
        `.vx/projects.lock has no entry for "${name}" (${name}/vx.config.ts) — run \`vx lock\``,
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
    // trusted, and `--check` is the audit. The one check a run makes,
    // a config FILE edited since this machine's `vx lock`
    // (memo/config-stamps.ts), is a reminder, not an audit: it asks
    // nothing of a lock it did not see written, as this one. Anyone tightening this should
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
    // 2026-10-14), down to each task's `dependsOn`. A broken entry an edit
    // left below that is the audit's to catch.
    const shape = { tasks: { build: { exec: { command: 5 } } } } as unknown as ProjectConfig
    await writeLockfile(root, lock({ projects: { pkg: entry(shape) } }))
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
