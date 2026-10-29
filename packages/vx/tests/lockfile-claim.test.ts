// The claimant's shell (`lockfileClaim`): the memo, the per-run gate, the
// fallback for an unlisted project and the `--affected` diff, with a fake
// digest so the pins are about the shell and not a lockfile format. The
// real formats are pinned in @vzn/vx-lockfile, one file per manager.
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { lockfileClaim, reachDigests } from '../src/index.js'
import type { TaskNode } from '../src/graph/index.js'

let root: string
let calls: string[]

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-claim-'))
  await mkdir(path.join(root, '.vx', 'cache'), { recursive: true })
  // The index a run makes: the memo is one of its rows.
  new Cache(path.join(root, '.vx', 'cache')).close()
  calls = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A "lockfile" whose lines are `dir=digest`; the digest records every parse. */
function claim(scope?: 'project' | 'workspace') {
  return lockfileClaim({
    file: 'bun.lock',
    version: 1,
    ...(scope === undefined ? {} : { scope }),
    digest: (text) => {
      calls.push(text)
      const out = new Map<string, string>()
      for (const line of text.split('\n')) {
        const [dir, digest] = line.split('=')
        if (dir && digest) out.set(dir, digest)
      }
      return out
    },
  })
}
const ctx = () => ({ workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} })
const task = (dir: string) => ({ projectDir: path.join(root, dir) }) as TaskNode
const lock = (text: string) => writeFile(path.join(root, 'bun.lock'), text)
type Memo = {
  version: number
  extras: Record<string, string>
  importers: Record<string, string>
  edges: Record<string, unknown>
  recorded: Record<string, string[]> | null
}
const JSON_COLUMNS = ['extras', 'importers', 'edges', 'recorded'] as const
/** bun.lock's memo row the last write left, its JSON columns parsed. */
function readMemo(): Memo {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    const row = db
      .query(
        "SELECT version, extras, importers, edges, recorded FROM lockfile_memos WHERE file = 'bun.lock' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as Record<string, unknown>
    for (const c of JSON_COLUMNS) row[c] = row[c] === null ? null : JSON.parse(row[c] as string)
    return row as Memo
  } finally {
    db.close()
  }
}
/** Rewrite that row as `edit` leaves it. */
function editMemo(edit: (memo: Memo) => void): void {
  const memo = readMemo()
  edit(memo)
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    db.run(
      `UPDATE lockfile_memos SET extras = ?, importers = ?, edges = ?, recorded = ?
       WHERE rowid = (SELECT MAX(rowid) FROM lockfile_memos WHERE file = 'bun.lock')`,
      JSON_COLUMNS.map((c) => (memo[c] === null ? null : JSON.stringify(memo[c]))),
    )
  } finally {
    db.close()
  }
}

// bun.lock names a patch file by PATH and records no hash of it: an edited
// patch left the lockfile byte-identical, every key unmoved, and
// `--affected` silent while the install applied the new patch (item 1014).
// A claim's `extraFiles` are hashed and handed to `digest`.
describe('extra files the lockfile names', () => {
  /** Lines `dir=digest`, and `extra:<path>` naming a file whose hash each digest folds. */
  const withExtras = () =>
    lockfileClaim({
      file: 'bun.lock',
      version: 1,
      extraFiles: (text) =>
        text
          .split('\n')
          .filter((l) => l.startsWith('extra:'))
          .map((l) => l.slice('extra:'.length)),
      digest: (text, files) => {
        calls.push(text)
        const folded = [...files].map(([f, h]) => `${f}:${h}`).join(',')
        const out = new Map<string, string>()
        for (const line of text.split('\n')) {
          const [dir, digest] = line.split('=')
          if (dir && digest) out.set(dir, `${digest}|${folded}`)
        }
        return out
      },
    })
  const patch = (text: string) =>
    mkdir(path.join(root, 'patches'), { recursive: true }).then(() =>
      writeFile(path.join(root, 'patches', 'p.patch'), text),
    )

  it('an edited extra file moves the key, in a new process and in the same one', async () => {
    await lock('packages/a=a1\nextra:patches/p.patch\n')
    await patch('one')
    const first = (await withExtras().key(task('packages/a'), ctx()))!['deps']
    await patch('two!')
    const hooks = withExtras()
    const second = (await hooks.key(task('packages/a'), ctx()))!['deps']
    expect(second).not.toBe(first)
    await patch('three!!')
    const third = (await hooks.key(task('packages/a'), ctx()))!['deps']
    expect(new Set([first, second, third]).size).toBe(3)
  })

  // X-130: the memo was one file per lockfile, trusted on its version and
  // the lockfile's hash. Another claimant of the file at the same version
  // (a plugin swapped in the same cache dir) read a memo that named no
  // extra file, so its patch edits never moved the key.
  it("another claimant's memo is not trusted", async () => {
    await lock('packages/a=a1\nextra:patches/p.patch\n')
    await patch('one')
    await claim().key(task('packages/a'), ctx())
    const first = (await withExtras().key(task('packages/a'), ctx()))!['deps']
    await patch('two!')
    expect((await withExtras().key(task('packages/a'), ctx()))!['deps']).not.toBe(first)
  })

  // Read as absent, an extra file that is there but unreadable folded as
  // '' — the key of no patch at all — while settings files refuse so. A
  // symlink loop is unreadable to root too (EACCES is not).
  it('an extra file that is there but unreadable refuses the key, named', async () => {
    const { symlink } = await import('node:fs/promises')
    await lock('packages/a=a1\nextra:patches/p.patch\n')
    await mkdir(path.join(root, 'patches'), { recursive: true })
    await symlink('p.patch', path.join(root, 'patches', 'p.patch'))
    await expect(withExtras().key(task('packages/a'), ctx())).rejects.toThrow(
      'patches/p.patch: cannot be read (',
    )
    // CONTROL: an absent one is absent.
    await rm(path.join(root, 'patches', 'p.patch'))
    expect((await withExtras().key(task('packages/a'), ctx()))!['deps']).toBe('a1|patches/p.patch:')
  })

  // `--affected` asks which files a lockfile names for every diff (one may
  // sit inside a project), and parsed the lockfile cold to learn what the
  // memo already records for these bytes.
  it("--affected's extra files come from the memo, not a parse", async () => {
    const counting = () => {
      const hooks = withExtras()
      return { hooks, extraFiles: hooks.fingerprint!.extraFiles! }
    }
    await lock('packages/a=a1\nextra:patches/p.patch\n')
    await patch('one')
    const bytes = await Bun.file(path.join(root, 'bun.lock')).bytes()
    const fctx = { ...ctx(), projects: [] }
    // CONTROL: no memo yet, so the lockfile is parsed.
    const cold = counting()
    expect(await cold.extraFiles('bun.lock', bytes, fctx)).toEqual(['patches/p.patch'])
    await cold.hooks.key(task('packages/a'), ctx())
    const warm = counting()
    editMemo((m) => {
      m.extras = { 'patches/from-the-memo': m.extras['patches/p.patch']! }
    })
    expect(await warm.extraFiles('bun.lock', bytes, fctx)).toEqual(['patches/from-the-memo'])
    // Other bytes are not the memo's: parsed.
    const other = new TextEncoder().encode('packages/a=a2\nextra:patches/q.patch\n')
    expect(await warm.extraFiles('bun.lock', other, fctx)).toEqual(['patches/q.patch'])
  })

  it('CONTROL: an unchanged extra file costs a warm run no parse', async () => {
    await lock('packages/a=a1\nextra:patches/p.patch\n')
    await patch('one')
    const first = (await withExtras().key(task('packages/a'), ctx()))!['deps']
    const parses = calls.length
    expect((await withExtras().key(task('packages/a'), ctx()))!['deps']).toBe(first)
    expect(calls.length).toBe(parses)
  })
})

describe('key', () => {
  it("folds the project's digest, the root's for an unlisted project, and nothing without a file", async () => {
    const hooks = claim()
    expect(await hooks.key(task('packages/a'), ctx())).toBeUndefined()
    await lock('packages/a=a1\n')
    expect(await hooks.key(task('packages/a'), ctx())).toEqual({ deps: 'a1' })
    await lock('.=root1\npackages/a=a1\n')
    expect(await hooks.key(task('packages/b'), ctx())).toEqual({ deps: 'root1' })
    expect(await hooks.key(task('.'), ctx())).toEqual({ deps: 'root1' })
  })

  it("a listed project folds the root importer's digest too: the root's tools are on its PATH", async () => {
    // The root `node_modules/.bin` is on every task's PATH and Node's
    // resolution walks up to the root `node_modules`, so a root
    // devDependency bump that moved no project's key replayed the old
    // tool's output (nx#36415 class, 2026-09-24).
    const hooks = claim()
    const key = async (text: string, dir: string) => {
      await lock(text)
      return (await hooks.key(task(dir), ctx()))!['deps']!
    }
    const base = await key('.=root1\npackages/a=a1\npackages/b=b1\n', 'packages/a')
    const rootMoved = await key('.=root2\npackages/a=a1\npackages/b=b1\n', 'packages/a')
    const ownMoved = await key('.=root1\npackages/a=a2\npackages/b=b1\n', 'packages/a')
    const sibling = await key('.=root1\npackages/a=a1\npackages/b=b2\n', 'packages/a')
    expect(new Set([base, rootMoved, ownMoved]).size).toBe(3)
    // CONTROL: a sibling's own closure is not a's.
    expect(sibling).toBe(base)
    // Neither half alone: a's key is not the root's, nor its own bare digest.
    expect(base).not.toBe('root1')
    expect(base).not.toBe('a1')
  })

  // A project with no manifest of its own inside a listed one
  // (`packages/a/e2e`) resolves its modules from `packages/a/node_modules`
  // before the root's. Folding the root's digest alone, a bump only `a`
  // reaches moved no key of it, and its task replayed the old output.
  it("a project inside a listed one folds the nearest listed ancestor's digest", async () => {
    const hooks = claim()
    const key = async (text: string, dir: string) => {
      await lock(text)
      return (await hooks.key(task(dir), ctx()))!['deps']!
    }
    const base = await key('.=root1\npackages/a=a1\npackages/b=b1\n', 'packages/a/e2e')
    expect(base).toBe(await key('.=root1\npackages/a=a1\npackages/b=b1\n', 'packages/a'))
    expect(await key('.=root1\npackages/a=a2\npackages/b=b1\n', 'packages/a/e2e')).not.toBe(base)
    // CONTROL: a sibling's closure is not its; a dir that only shares a prefix is not inside.
    expect(await key('.=root1\npackages/a=a1\npackages/b=b2\n', 'packages/a/e2e')).toBe(base)
    expect(await key('.=root1\npackages/a=a1\n', 'packages/ab')).toBe('root1')
  })

  it('parses once per content: the memo serves the next process, the context the next task', async () => {
    // No root importer: these rows are about the memo, so a's key is its own digest.
    await lock('packages/a=a1\n')
    const first = claim()
    const run = ctx()
    await first.key(task('packages/a'), run)
    await first.key(task('packages/b'), run)
    expect(calls).toHaveLength(1)
    // The memo is a row of cache.db, keyed by version + content hash, and no file.
    const memo = readMemo()
    expect(await readdir(path.join(root, '.vx', 'cache'))).not.toContain('lockfile-claims')
    expect(memo.version).toBe(1)
    expect(memo.importers).toEqual({ 'packages/a': 'a1' })
    // A fresh instance (a new process) reads the memo instead of parsing.
    const second = claim()
    expect(await second.key(task('packages/a'), ctx())).toEqual({ deps: 'a1' })
    expect(calls).toHaveLength(1)
    // A planted memo is what keys the task: the proof the file was not parsed.
    editMemo((m) => {
      m.importers['packages/a'] = 'planted'
    })
    expect(await claim().key(task('packages/a'), ctx())).toEqual({ deps: 'planted' })
    expect(calls).toHaveLength(1)
    // Changed bytes ignore the stale memo and parse again.
    await lock('packages/a=a2\n')
    expect(await claim().key(task('packages/a'), ctx())).toEqual({ deps: 'a2' })
    expect(calls).toHaveLength(2)
  })

  it('a parse that throws writes no memo: the next process parses, and refuses, again', async () => {
    await lock('broken\n')
    const throwing = () =>
      lockfileClaim({
        file: 'bun.lock',
        version: 1,
        digest: (text) => {
          calls.push(text)
          throw new Error('bun.lock: not JSON')
        },
      })
    for (let i = 1; i <= 2; i++) {
      await expect(throwing().key(task('packages/a'), ctx())).rejects.toThrow('not JSON')
      expect(calls).toHaveLength(i)
    }
    expect(await Bun.file(MEMO()).exists()).toBe(false)
  })

  it('a same-size rewrite with its mtime kept is read again in the same process', async () => {
    // `cp -p` / `tar -x` of another lockfile: size and mtime match the last
    // read, and only the ctime and inode say the bytes moved. The waits put
    // each stamp past the 50 ms racy window, where the identity is trusted.
    const file = path.join(root, 'bun.lock')
    const kept = 1_700_000_000.25
    await lock('packages/a=a1\n')
    await utimes(file, kept, kept)
    await Bun.sleep(60)
    const hooks = claim()
    expect(await hooks.key(task('packages/a'), ctx())).toEqual({ deps: 'a1' })
    await lock('packages/a=a2\n')
    await utimes(file, kept, kept)
    await Bun.sleep(60)
    expect(await hooks.key(task('packages/a'), ctx())).toEqual({ deps: 'a2' })
  })

  it('a memo of another digest version is not trusted', async () => {
    await lock('.=root1\n')
    await claim().key(task('.'), ctx())
    const hooks = lockfileClaim({
      file: 'bun.lock',
      version: 2,
      digest: () => new Map([['.', 'v2']]),
    })
    expect(await hooks.key(task('.'), ctx())).toEqual({ deps: 'v2' })
  })

  it('scope: workspace folds the file hash into every task and never parses', async () => {
    await lock('.=root1\npackages/a=a1\n')
    const hooks = claim('workspace')
    const a = await hooks.key(task('packages/a'), ctx())
    const b = await hooks.key(task('packages/b'), ctx())
    expect(a).toEqual(b)
    expect(a).toHaveProperty('deps')
    expect(calls).toHaveLength(0)
    await lock('.=root1\npackages/a=a2\n')
    expect(await hooks.key(task('packages/b'), ctx())).not.toEqual(b)
  })

  it('names the part as asked', async () => {
    await lock('.=root1\n')
    const hooks = lockfileClaim({
      file: 'bun.lock',
      version: 1,
      part: 'bun',
      digest: () => new Map([['.', 'r']]),
    })
    expect(await hooks.key(task('.'), ctx())).toEqual({ bun: 'r' })
  })

  it('a memo it CANNOT write is a speed-up lost, never a failed run', async () => {
    // The memo is written into the cache index; if that write fails — a
    // read-only cache, a full disk, a path that is not a directory — the
    // digests were computed anyway and the run must carry on. The next run
    // simply computes them again.
    await lock('packages/a=a1\n')
    const blocked = path.join(root, 'not-a-dir')
    await writeFile(blocked, 'this is a file, so no index can be made under it')
    const hooks = claim()
    const blockedCtx = { workspaceRoot: root, cacheDir: blocked, warn() {} }
    expect(await hooks.key(task('packages/a'), blockedCtx)).toEqual({ deps: 'a1' })
    // A second run over the same content re-parses, since nothing was
    // memoised — the cost the memo exists to avoid, paid rather than fatal.
    expect(await claim().key(task('packages/a'), { ...blockedCtx })).toEqual({ deps: 'a1' })
    expect(calls.length).toBe(2)
  })

  // A `discover` hook reads the memo before a first run has made the index:
  // the parse it pays then is kept once the index exists, by the same
  // process's next read, though that read is served from memory.
  it('a memo with no index to keep it in is kept once there is one', async () => {
    await lock('packages/a=a1\n')
    const cacheDir = path.join(root, 'fresh')
    await mkdir(cacheDir)
    const fresh = { ...ctx(), cacheDir }
    const hooks = claim()
    expect(await hooks.importers(fresh)).toEqual(new Map())
    expect(await readdir(cacheDir)).toEqual([])
    new Cache(cacheDir).close()
    expect(await hooks.key(task('packages/a'), fresh)).toEqual({ deps: 'a1' })
    expect(await claim().key(task('packages/a'), fresh)).toEqual({ deps: 'a1' })
    expect(calls).toHaveLength(1)
  })

  it('refuses an unknown scope', () => {
    expect(() =>
      lockfileClaim({ file: 'bun.lock', version: 1, digest: () => new Map(), scope: 'x' as never }),
    ).toThrow(/scope must be 'project' or 'workspace'/)
  })
})

// A `discover` hook reads each importer's links from the memo the digests
// live in, so a warm run parses nothing to learn its edges (language-
// agnostic core, PR 2). Lines `dir>target` link two importers.
describe('importers', () => {
  const withImporters = (scope?: 'project' | 'workspace') =>
    lockfileClaim({
      file: 'bun.lock',
      version: 1,
      ...(scope === undefined ? {} : { scope }),
      digest: () => new Map(),
      importers: (text) => {
        calls.push(text)
        const out = new Map<string, { deps: Record<string, string>; peers: {} }>()
        for (const line of text.split('\n')) {
          const [dir, target] = line.split('>')
          if (dir && target) out.set(dir, { deps: { [target]: target }, peers: {} })
        }
        return out
      },
    })

  it('are undefined without a file, then served from the memo in a new process', async () => {
    expect(await withImporters().importers(ctx())).toBeUndefined()
    await lock('packages/a>packages/b\n')
    const want = new Map([['packages/a', { deps: { 'packages/b': 'packages/b' }, peers: {} }]])
    expect(await withImporters().importers(ctx())).toEqual(want)
    expect(calls).toHaveLength(1)
    editMemo((m) => {
      m.edges['packages/a'] = { deps: { b: 'planted' }, peers: {} }
    })
    expect(await withImporters().importers(ctx())).toEqual(
      new Map([['packages/a', { deps: { b: 'planted' }, peers: {} }]]),
    )
    expect(calls).toHaveLength(1)
  })

  // A staleness check reads the names each importer records; parsed on every
  // run before, by the plugin, into a file of its own under the cache dir.
  it('recorded names are served from the memo in a new process', async () => {
    const withRecorded = () =>
      lockfileClaim({
        file: 'bun.lock',
        version: 1,
        digest: () => new Map(),
        recorded: (text) => {
          calls.push(text)
          return new Map([['.', text.trim().split(',')]])
        },
      })
    expect(await withRecorded().recorded(ctx())).toBeUndefined()
    await lock('a,b\n')
    expect(await withRecorded().recorded(ctx())).toEqual(new Map([['.', new Set(['a', 'b'])]]))
    editMemo((m) => {
      m.recorded = { '.': ['planted'] }
    })
    expect(await withRecorded().recorded(ctx())).toEqual(new Map([['.', new Set(['planted'])]]))
    expect(calls).toHaveLength(1)
  })

  it('scope: workspace still records them, and its memo is not a project-scope memo', async () => {
    await lock('packages/a>packages/b\n')
    const want = new Map([['packages/a', { deps: { 'packages/b': 'packages/b' }, peers: {} }]])
    expect(await withImporters('workspace').importers(ctx())).toEqual(want)
    expect(await withImporters('workspace').importers(ctx())).toEqual(want)
    expect(calls).toHaveLength(1)
    // A project-scope claimant does not read the workspace memo's empty digests.
    await withImporters().importers(ctx())
    expect(calls).toHaveLength(2)
  })
})

describe('affected', () => {
  const projects = () => [
    { name: 'a', dir: path.join(root, 'packages/a') },
    { name: 'b', dir: path.join(root, 'packages/b') },
    { name: 'tools', dir: path.join(root, 'tools') },
  ]
  const bytes = (s: string) => new TextEncoder().encode(s)
  const ask = (hooks: ReturnType<typeof claim>, before: string | null, after: string | null) =>
    hooks.fingerprint.affected(
      {
        file: 'bun.lock',
        before: before === null ? null : bytes(before),
        after: after === null ? null : bytes(after),
      },
      { ...ctx(), projects: projects() },
    )

  it('names the projects whose digest moved; a root move moves every project', async () => {
    const base = '.=r1\npackages/a=a1\npackages/b=b1\n'
    expect([...(await ask(claim(), base, '.=r1\npackages/a=a2\npackages/b=b1\n'))!]).toEqual(['a'])
    expect([...(await ask(claim(), base, '.=r2\npackages/a=a1\npackages/b=b1\n'))!]).toEqual([
      'a',
      'b',
      'tools',
    ])
    expect([...(await ask(claim(), base, base))!]).toEqual([])
  })

  it("a project inside a listed one moves with that one's digest", async () => {
    const base = '.=r1\npackages/a=a1\npackages/b=b1\n'
    const nested = [...projects(), { name: 'e2e', dir: path.join(root, 'packages/a/e2e') }]
    const moved = await claim().fingerprint.affected(
      {
        file: 'bun.lock',
        before: bytes(base),
        after: bytes('.=r1\npackages/a=a2\npackages/b=b1\n'),
      },
      { ...ctx(), projects: nested },
    )
    expect([...moved!]).toEqual(['a', 'e2e'])
  })

  it('a side that cannot be parsed is refused, and the refusal names WHICH side', async () => {
    // "your lockfile is broken" and "the base commit's is" are different
    // problems with different fixes — a lockfile-migration commit hits the
    // second — and the parser's own message names neither (2026-09-20).
    const strict = lockfileClaim({
      file: 'bun.lock',
      version: 1,
      digest: (text) => {
        if (text.includes('broken')) throw new Error('bun.lock: not a lockfile')
        return new Map([['.', text.trim()]])
      },
    })
    // The hook is synchronous for a claim whose digest is, so the refusal
    // arrives as a throw rather than a rejection.
    expect(() => ask(strict, 'broken', '.=r1\n')).toThrow(
      'bun.lock: not a lockfile (as of the base ref)',
    )
    expect(() => ask(strict, '.=r1\n', 'broken')).toThrow(
      'bun.lock: not a lockfile (in the working tree)',
    )
    // CONTROL: two sides that parse still answer with the moved projects.
    expect([...(await ask(strict, '.=r1\n', '.=r2\n'))!]).toEqual(['a', 'b', 'tools'])
  })

  it('cannot tell when the file appeared or went, or under scope: workspace', async () => {
    expect(await ask(claim(), null, '.=r1\n')).toBeUndefined()
    expect(await ask(claim(), '.=r1\n', null)).toBeUndefined()
    expect(await ask(claim('workspace'), '.=r1\n', '.=r2\n')).toBeUndefined()
  })
})

describe('reachDigests', () => {
  // 0 → 1 → 2, 2 → 1 (a cycle), 3 alone.
  const graph = (m: string[]) => ({ material: m, edges: [[1], [2], [1], []] })

  it('moves a node when anything it reaches changes, and only then', () => {
    const before = reachDigests(graph(['a', 'b', 'c', 'd']))
    const deep = reachDigests(graph(['a', 'b', 'c2', 'd']))
    expect(deep[0]).not.toBe(before[0])
    expect(deep[1]).not.toBe(before[1])
    expect(deep[2]).not.toBe(before[2])
    expect(deep[3]).toBe(before[3])
    const leaf = reachDigests(graph(['a', 'b', 'c', 'd2']))
    expect(leaf.slice(0, 3)).toEqual(before.slice(0, 3))
    expect(leaf[3]).not.toBe(before[3])
  })

  it('is independent of node numbering and edge order', () => {
    const a = reachDigests({ material: ['x', 'y', 'z'], edges: [[1, 2], [], []] })
    const b = reachDigests({ material: ['z', 'x', 'y'], edges: [[], [2, 0], []] })
    expect(b[1]).toBe(a[0])
    expect(b[2]).toBe(a[1])
    expect(b[0]).toBe(a[2])
  })

  // Every member of a cycle shares one digest, which folded only the
  // members' material: an importer moved from `y@1.0.0` to `y@1.1.0`, both
  // in one cycle, kept its key, and so did two members swapping their
  // targets — a stale hit under a `pnpm update` (item 1013).
  it('moves when an edge is retargeted inside a cycle', () => {
    // 0 importer; 1 x, 2 y1, 3 y2, 4 z — one cycle: x→y1,z; z→y2,x; y1→x; y2→x.
    const cyc = (importer: number, x: number, z: number) =>
      reachDigests({
        material: ['imp', 'x', 'y1', 'y2', 'z'],
        edges: [[importer], [x, 4], [1], [1], [z, 1]],
      })
    const before = cyc(2, 2, 3)
    expect(cyc(3, 2, 3)[0]).not.toBe(before[0])
    expect(cyc(2, 3, 2)[1]).not.toBe(before[1])
    // CONTROL: the same edges in another order.
    expect(
      reachDigests({
        material: ['imp', 'x', 'y1', 'y2', 'z'],
        edges: [[2], [4, 2], [1], [1], [1, 3]],
      })[0],
    ).toBe(before[0])
  })

  // npm and bun key a node by what it is, not where it sits, so two copies
  // of one version are one material: `packages/a/node_modules/foo` → bar@1
  // and `node_modules/foo` → bar@2. Two workspaces in a cycle swapping
  // which copy each reaches gave the same lines and the same children,
  // and a's install moved from bar@1 to bar@2 under its old key.
  it('moves when cycle members swap two copies of one material that reach apart', () => {
    // 0 ↔ 1 (a, b); 2 and 3 both `foo`, 2 → 4 bar1, 3 → 5 bar2.
    const swap = (a: number, b: number) =>
      reachDigests({
        material: ['a', 'b', 'foo', 'foo', 'bar1', 'bar2'],
        edges: [[1, a], [0, b], [4], [5], [], []],
      })
    expect(swap(3, 2)[0]).not.toBe(swap(2, 3)[0])
    // CONTROL: a singleton's children already say where its edges land,
    // so an acyclic digest keeps its value.
    const single = reachDigests({ material: ['a', 'foo', 'bar1'], edges: [[1], [2], []] })[0]
    expect(single).toBe('38108168b5ad6712')
  })

  // The same swap one step in: the two `foo` copies are members of the
  // cycle themselves (each depends back on a), so their edges were named
  // by material, and a reaching bar@1 or bar@2 was one line.
  it('moves when cycle members swap two in-cycle copies of one material', () => {
    // 0 ↔ 1 (a, b); 2 and 3 both `foo`, each → 0; 2 → 4 bar1, 3 → 5 bar2.
    const swap = (a: number, b: number) =>
      reachDigests({
        material: ['a', 'b', 'foo', 'foo', 'bar1', 'bar2'],
        edges: [[1, a], [0, b], [0, 4], [0, 5], [], []],
      })
    expect(swap(3, 2)[0]).not.toBe(swap(2, 3)[0])
    // CONTROL: the same graph numbered otherwise digests alike.
    const renumbered = reachDigests({
      material: ['b', 'a', 'foo', 'foo', 'bar2', 'bar1'],
      edges: [[1, 2], [0, 3], [1, 4], [1, 5], [], []],
    })
    expect(renumbered[1]).toBe(swap(2, 3)[0])
  })

  it('a member of a cycle shares its component digest', () => {
    const d = reachDigests(graph(['a', 'b', 'c', 'd']))
    expect(d[1]).toBe(d[2])
    expect(d[0]).not.toBe(d[1])
  })

  it('a SELF-LOOP changes nothing — an edge inside a component is not a child', () => {
    // Children are the components a component points OUT to. An edge that
    // lands back inside it has already been folded as a member, and
    // counting it again would fold a digest that does not exist yet.
    const plain = reachDigests({ material: ['a'], edges: [[]] })
    const loop = reachDigests({ material: ['a'], edges: [[0]] })
    expect(loop[0]).toBe(plain[0])
  })

  it('a cycle LONGER than one edge is still one component', () => {
    // The two-node fixture above closes its cycle with a back edge to the
    // node one frame up, which the on-stack branch alone resolves. A
    // three-node cycle needs the low-link to travel back DOWN the frame
    // stack as each frame pops; without that the ring splits into three
    // components that each claim to reach the others.
    const d = reachDigests({ material: ['a', 'b', 'c'], edges: [[1], [2], [0]] })
    expect(d[0]).toBe(d[1])
    expect(d[1]).toBe(d[2])
    // CONTROL: the same three nodes in a CHAIN are three distinct digests.
    const chain = reachDigests({ material: ['a', 'b', 'c'], edges: [[1], [2], []] })
    expect(new Set(chain).size).toBe(3)
  })

  it('the order a node lists its edges in does not move its digest', () => {
    // The numbering row above permutes the nodes but leaves each node's
    // children arriving in the same order, so it cannot see the sort that
    // makes the fold order-free. Reversing ONE node's edge list can.
    const fwd = reachDigests({ material: ['x', 'y', 'z'], edges: [[1, 2], [], []] })
    const rev = reachDigests({ material: ['x', 'y', 'z'], edges: [[2, 1], [], []] })
    expect(rev[0]).toBe(fwd[0])
  })

  it('the order a COMPONENT pops its members in does not move its digest', () => {
    // Same argument one level down: a multi-member component folds its
    // members sorted, because the pop order off Tarjan's stack is an
    // artefact of where the walk entered the cycle.
    const ab = reachDigests({ material: ['a', 'b'], edges: [[1], [0]] })
    const ba = reachDigests({ material: ['b', 'a'], edges: [[1], [0]] })
    expect(ba[0]).toBe(ab[0])
    expect(ba[1]).toBe(ab[1])
  })

  it('a member and a child digest are in DIFFERENT sections — the counts separate them', () => {
    // The fold is members-then-children, and each section is introduced by
    // its count. Take those two introductions away together and the two
    // sections become one undifferentiated chain, where a node whose CHILD
    // digests to D collides with a component whose MEMBER material is the
    // string D. Child digests are 16 hex chars, which a lockfile's material
    // can be — an integrity hash, a resolved version string.
    const childOnly = reachDigests({ material: ['zz'], edges: [[]] })[0]!
    expect(childOnly).toMatch(/^[0-9a-f]{16}$/)
    const asChild = reachDigests({ material: ['a', 'zz'], edges: [[1], []] })[0]!
    const asMember = reachDigests({ material: ['a', childOnly], edges: [[1], [0]] })[0]!
    expect(asMember).not.toBe(asChild)
  })
})
