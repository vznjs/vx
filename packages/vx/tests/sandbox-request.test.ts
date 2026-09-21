// The filesystem groundwork a bind needs, and what vx leaves behind. bwrap
// cannot bind a path that does not exist, so a write grant is pre-created:
// a literal as an empty file, a glob's prefix or a `dir/` as a directory.
// The file placeholder is vx's until the task writes it — a task that
// meant a directory met "File exists" from its own mkdir and the empty
// file survived every later clean (2026-09-16), so the sweep takes back
// what the task never wrote, and the failure names the `dir/` spelling.

import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import {
  placeholderSweeper,
  sandboxRequestFor,
  sandboxRunUnion,
  sweepPlaceholders,
  untouchedPlaceholderLine,
} from '../src/orchestrator/sandbox-request.js'
import type { ExecConfig } from '../src/config.js'

let root: string
let dir: string

beforeEach(async () => {
  // CANONICAL, deliberately: macOS's temp dir is `/var/folders/...`, a
  // symlink to `/private/var/...`. `linkedDeps` realpaths a link's TARGET
  // and compares it against the granted directories as given, so under a
  // non-canonical root the "already inside a granted directory" dedup
  // never fires and every link is granted redundantly. That is harmless
  // (the parent is granted anyway) but it makes the dedup untestable, and
  // the row below is about the dedup rather than about macOS path
  // canonicalisation. Found by CI: the control failed on darwin only.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-sandbox-request-')))
  dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function node(): TaskNode {
  return {
    id: 'proj#build',
    projectName: 'proj',
    projectDir: dir,
    taskName: 'build',
    config: { exec: { command: 'true' } },
    deps: [],
    requested: true,
  }
}

const requestFor = (write: string[]) => sandboxRequestFor(node(), { allow: { write } }, root)

const kind = async (p: string): Promise<'file' | 'dir' | 'none'> => {
  const st = await stat(p).catch(() => undefined)
  return st === undefined ? 'none' : st.isDirectory() ? 'dir' : 'file'
}

describe('the run-wide union SRT is armed with', () => {
  // `prepareSandbox` folds every sandboxed task into ONE allowlist,
  // because SRT runs one filtering proxy per run and checks every request
  // against the list `initialize()` was given — never the per-call one.
  // That call is only observable through a live runtime, so these values
  // had no witness of any kind: dropping the domain fold, narrowing the
  // socket lift, and widening it so an EMPTY list lifts the filter for the
  // whole run all survived a whole-suite sweep (item 537).
  const sandboxed = (sandbox: NonNullable<ExecConfig['sandbox']>, id = 'proj#a'): TaskNode => ({
    ...node(),
    id,
    config: { exec: { command: 'true', sandbox } },
  })

  it('no sandboxed task means no union at all — the run arms nothing', () => {
    expect(sandboxRunUnion([node()])).toBeNull()
    expect(sandboxRunUnion([])).toBeNull()
  })

  it('domains are the UNION across tasks, deduped', () => {
    // One task's list is not the run's: a fold that kept only the first
    // (or the last) leaves every other task filtered against someone
    // else's allowlist.
    const u = sandboxRunUnion([
      sandboxed({ allow: { network: ['a.test', 'shared.test'] } }, 'proj#a'),
      sandboxed({ allow: { network: ['b.test', 'shared.test'] } }, 'proj#b'),
      sandboxed({}, 'proj#c'),
    ])
    expect(u?.domains.slice().sort()).toEqual(['a.test', 'b.test', 'shared.test'])
  })

  it('`network: true` contributes NO domain: it skips the proxy, it does not widen it', () => {
    // The naive fold adds `*` here, and that is the dangerous direction:
    // `true` means this task bypasses the proxy entirely (docs/schema.md),
    // so folding it in as a wildcard would hand every OTHER task in the
    // run an allowlist matching everything. The per-task config does map
    // it to `['*']` (sandbox-binds), which is exactly why the run-wide
    // fold must not.
    const u = sandboxRunUnion([
      sandboxed({ allow: { network: true } }, 'proj#open'),
      sandboxed({ allow: { network: ['only.test'] } }, 'proj#narrow'),
    ])
    expect(u?.domains).toEqual(['only.test'])
  })

  it('the unix-socket lift is per RUN, and an EMPTY list does not lift it', () => {
    // SRT's `socket(AF_UNIX)` seccomp filter is all-or-nothing and read at
    // initialize(), so any task needing sockets lifts it for everyone.
    // `unixSockets: []` says NONE, and reading an empty array as "a list
    // was given, so allow all" is the one direction that silently widens
    // the whole run.
    const lift = (u: ReturnType<typeof sandboxRunUnion>): boolean | undefined => u?.unixSockets
    expect(lift(sandboxRunUnion([sandboxed({ allow: { unixSockets: true } })]))).toBe(true)
    expect(lift(sandboxRunUnion([sandboxed({ allow: { unixSockets: ['/tmp/x.sock'] } })]))).toBe(
      true,
    )
    expect(lift(sandboxRunUnion([sandboxed({ allow: { unixSockets: [] } })]))).toBe(false)
    expect(lift(sandboxRunUnion([sandboxed({})]))).toBe(false)
    // …and one task asking is enough for the run.
    expect(
      lift(
        sandboxRunUnion([
          sandboxed({}, 'proj#a'),
          sandboxed({ allow: { unixSockets: true } }, 'proj#b'),
        ]),
      ),
    ).toBe(true)
  })

  it.skipIf(process.platform !== 'linux')(
    'a localBinding port list lifts the socket filter on Linux — its bridge IS a unix socket',
    () => {
      // The task's side of the port bridge creates one, so a run with a
      // localBinding task must lift the filter even though it declared no
      // `unixSockets`. An empty port list asks for no bridge.
      const u = sandboxRunUnion([sandboxed({ allow: { localBinding: [3000] } })])
      expect(u?.unixSockets).toBe(true)
      expect(sandboxRunUnion([sandboxed({ allow: { localBinding: [] } })])?.unixSockets).toBe(false)
    },
  )

  it('the weaker nested profile needs EVERY task to accept it, not one', () => {
    // A run-wide setting taken from `some` would let one task's opt-in
    // weaken the profile every other sandboxed task runs under. The
    // BEHAVIOUR is macOS-only (nested seatbelt), which is why it is
    // pinned here as the reduction it is, on every platform.
    const yes = { weakerWhenNested: true } as NonNullable<ExecConfig['sandbox']>
    expect(
      sandboxRunUnion([sandboxed(yes, 'proj#a'), sandboxed(yes, 'proj#b')])?.weakerNested,
    ).toBe(true)
    expect(sandboxRunUnion([sandboxed(yes, 'proj#a'), sandboxed({}, 'proj#b')])?.weakerNested).toBe(
      false,
    )
  })
})

describe('a write grant is pre-created for the bind', () => {
  it('a literal names a file: an empty placeholder, reported', async () => {
    const r = await requestFor(['dist/vx'])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('file')
    expect(r.placeholders.map((p) => p.path)).toEqual([path.join(dir, 'dist/vx')])
  })

  it('a trailing slash names a directory: created, no placeholder', async () => {
    const r = await requestFor(['dist/'])
    expect(await kind(path.join(dir, 'dist'))).toBe('dir')
    expect(r.placeholders).toEqual([])
  })

  it('a glob names its static prefix as a directory', async () => {
    const r = await requestFor(['coverage/**'])
    expect(await kind(path.join(dir, 'coverage'))).toBe('dir')
    expect(r.placeholders).toEqual([])
  })

  it('`?` and `[...]` mark a glob too: no literal file is bound for one', async () => {
    // The wildcard test is a character class listing four metacharacters
    // and every fixture spells `*` — including every `**`, which is why a
    // glob must carry `?` or `[` and NO star to reach the gap at all.
    // Narrow the class to `*` and `out?` stops looking like a glob, so it
    // is bound as an empty FILE literally named `out?`: the 2026-09-16
    // trap ("File exists" from the task's own mkdir, the file surviving
    // every later clean) arriving by a spelling no row covers.
    // (Their static prefix is `.`, deliberately — `out?` names no single
    // directory, so there is nothing to pre-create. What must not happen
    // is the literal.) One fixture per metacharacter.
    for (const g of ['out?', 'gen[ab]']) {
      const r = await requestFor([g])
      expect(r.placeholders).toEqual([])
      expect(await kind(path.join(dir, g))).toBe('none')
    }
  })

  it('what is already there is what the task meant: a directory stays one', async () => {
    await mkdir(path.join(dir, 'dist'))
    const r = await requestFor(['dist'])
    expect(await kind(path.join(dir, 'dist'))).toBe('dir')
    expect(r.placeholders).toEqual([])
  })

  it('the request itself is unchanged by the spelling: `dist/` grants `dist`', async () => {
    const slash = await requestFor(['dist/'])
    const plain = await requestFor(['dist'])
    expect(slash.sandbox.config.allowWrite).toEqual(plain.sandbox.config.allowWrite)
  })
})

describe('the request derives nothing from cache', () => {
  // `SandboxConfig`'s doc comment claimed the baseline could "write the
  // prefixes of its `cache.outputs.files`" — three times over — while the
  // code granted none of it (item 443). The behavioural rows live in
  // `sandbox-runtime.unsafe.test.ts` and are Linux-gated on the bwrap
  // denial message; this pins the same claim where it actually lives, on
  // every platform, with no sandbox required to run it.
  it('a task declaring cache.outputs and no grant gets an EMPTY write baseline', async () => {
    const n: TaskNode = {
      ...node(),
      config: {
        exec: { command: 'true' },
        cache: {
          inputs: { files: ['src/**'] },
          outputs: { files: ['dist/**', 'out.txt'] },
        },
      },
    }
    const { sandbox } = await sandboxRequestFor(n, {}, root)
    expect(sandbox.baseAllowWrite).toEqual([])
    // …and the read baseline is dependencies, never the declared inputs.
    expect(sandbox.baseAllowRead.some((p) => p.includes('src'))).toBe(false)
    expect(sandbox.baseAllowRead.every((p) => p.includes('node_modules'))).toBe(true)
  })

  it('CONTROL: an explicit grant is what fills the write baseline', async () => {
    const { sandbox } = await requestFor(['dist/'])
    expect(sandbox.baseAllowWrite).toEqual([])
    expect(sandbox.config.allowWrite.some((p) => p.endsWith('dist'))).toBe(true)
  })
})

describe('a workspace link is granted by its real path, not by a string prefix', () => {
  // `node_modules` is granted, and a workspace dependency inside it is a
  // SYMLINK to a sibling project — so its target is granted too, or a task
  // cannot import what its own package.json depends on. Targets already
  // INSIDE a granted directory are dropped as redundant, and that test is
  // a path comparison: a sibling whose name merely STARTS WITH a granted
  // directory's is not inside it. `node_modules-extra` is not in
  // `node_modules`, and a prefix test without the separator says it is —
  // the sibling-prefix mistake this repo has now met three times (520 on
  // sandbox write grants, 527 on static prefixes, here on dep grants).
  it('a link whose target merely shares a granted prefix is still granted', async () => {
    const sibling = path.join(root, 'node_modules-extra', 'pkg')
    await mkdir(sibling, { recursive: true })
    await mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await symlink(sibling, path.join(dir, 'node_modules', 'dep'))

    const { sandbox } = await sandboxRequestFor(node(), {}, root)
    const granted = await Promise.all(sandbox.baseAllowRead.map((p) => realpath(p).catch(() => p)))
    expect(granted).toContain(await realpath(sibling))
  })

  it('a SCOPED link is found too: the scan descends one level into `@scope/`', async () => {
    // A package manager writes a scoped dependency as
    // `node_modules/@acme/pkg`, one level deeper than an unscoped one, so
    // the scan takes that step explicitly. Without it a scoped workspace
    // dependency is simply not granted and the task cannot import it —
    // invisible to every row above, which all spell an unscoped name.
    const sibling = path.join(root, 'packages', 'acme-pkg')
    await mkdir(sibling, { recursive: true })
    await mkdir(path.join(dir, 'node_modules', '@acme'), { recursive: true })
    await symlink(sibling, path.join(dir, 'node_modules', '@acme', 'pkg'))

    const { sandbox } = await sandboxRequestFor(node(), {}, root)
    const granted = await Promise.all(sandbox.baseAllowRead.map((p) => realpath(p).catch(() => p)))
    expect(granted).toContain(await realpath(sibling))
  })

  it('CONTROL: a link that really is inside a granted directory is dropped as redundant', async () => {
    // The other direction, so the row above cannot be satisfied by
    // granting every link target outright.
    const inside = path.join(dir, 'node_modules', 'real-pkg')
    await mkdir(inside, { recursive: true })
    await symlink(inside, path.join(dir, 'node_modules', 'alias'))

    const { sandbox } = await sandboxRequestFor(node(), {}, root)
    const granted = await Promise.all(sandbox.baseAllowRead.map((p) => realpath(p).catch(() => p)))
    expect(granted).not.toContain(await realpath(inside))
  })
})

describe('sweepPlaceholders takes back what the task never wrote', () => {
  it('an untouched placeholder is removed and named', async () => {
    const r = await requestFor(['dist/vx'])
    const untouched = await sweepPlaceholders(r.placeholders)
    expect(untouched).toEqual([path.join(dir, 'dist/vx')])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('none')
  })

  // The property the persistent path's two askers race over: the SECOND
  // sweep returns nothing, because the first one already removed the file.
  // Reading only the second one lost the "named nothing on disk" hint
  // whenever the child's exit handler swept first, and the failure then
  // said only "File exists" — the message the hint exists to explain
  // (seen under the gate's parallel load, 2026-09-20).
  it('a second sweep names nothing: the first one took it', async () => {
    const r = await requestFor(['dist/vx'])
    expect(await sweepPlaceholders(r.placeholders)).toEqual([path.join(dir, 'dist/vx')])
    expect(await sweepPlaceholders(r.placeholders)).toEqual([])
  })

  // So execute-task shares ONE sweep rather than running a second and
  // unioning the lists. The union looks equivalent and is not: it covers
  // an exit handler that FINISHED, while one still between its `rm` and
  // its return has published nothing, and the readiness path's own sweep
  // then finds the file already gone. Both lists are empty and the hint
  // is lost — reproduced deterministically by delaying each side in turn
  // (item 450), which is the flake the row above was written after.
  // The row ABOVE is this one's control: asked raw, the late caller gets
  // an empty list. Note which interleaving actually loses the hint — two
  // RAW sweeps started together both stat before either removes, so they
  // agree; it is the caller that arrives after the first `rm` that is
  // served nothing, and under load that is the readiness path. Both
  // shapes are asked here, concurrent and after.
  it('every asker of a shared sweep gets the same list, concurrently or after', async () => {
    const r = await requestFor(['dist/vx'])
    const sweep = placeholderSweeper(r.placeholders)
    const [first, second] = await Promise.all([sweep(), sweep()])
    expect(first).toEqual([path.join(dir, 'dist/vx')])
    expect(second).toEqual([path.join(dir, 'dist/vx')])
    expect(await sweep()).toEqual([path.join(dir, 'dist/vx')])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('none')
  })

  it('a placeholder the task wrote is its output and stays', async () => {
    const r = await requestFor(['dist/vx'])
    await writeFile(path.join(dir, 'dist/vx'), 'bytes')
    expect(await sweepPlaceholders(r.placeholders)).toEqual([])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('file')
  })

  // The sweep ANDs three conditions — still a file, still empty, mtime
  // untouched — and the row above trips every changeable one at once:
  // writing `bytes` moves the size AND the mtime, so either guard alone
  // still saves the file. The two shapes below move exactly one each, and
  // each is a real producer rather than a contrivance. Getting them wrong
  // is vx DELETING A FILE THE TASK WROTE and reporting it as litter it
  // took back.
  it('an EMPTY file the task wrote is its output and stays', async () => {
    // `touch dist/.keep`, a marker, an empty `.tsbuildinfo`, `: > dist/vx`.
    // Size stays 0, so only the mtime guard tells this from a placeholder
    // nobody touched.
    const r = await requestFor(['dist/vx'])
    const p = path.join(dir, 'dist/vx')
    const before = r.placeholders[0]!.mtimeMs
    // A distinct mtime is the whole signal, so make it distinct rather
    // than assuming the clock moved between two syscalls.
    const later = new Date(before + 2000)
    await utimes(p, later, later)
    expect((await stat(p)).size).toBe(0)
    expect((await stat(p)).mtimeMs).not.toBe(before)

    expect(await sweepPlaceholders(r.placeholders)).toEqual([])
    expect(await kind(p)).toBe('file')
  })

  it('a file the task wrote WITHOUT moving its mtime stays', async () => {
    // `cp -p`, `tar -x`, `unzip`, `rsync --times`, any SOURCE_DATE_EPOCH
    // generator — the same producer class that forced ctime into the
    // file-hash memo, because they write content and restore the mtime.
    // Size is then the only signal.
    const r = await requestFor(['dist/vx'])
    const p = path.join(dir, 'dist/vx')
    // `mtimeMs` carries sub-millisecond precision that a Date cannot
    // round-trip, so the file is first normalised to a whole millisecond
    // and the record taken FROM that — otherwise the restore below misses
    // by a fraction and the sweep skips the file for the wrong reason.
    const fixed = new Date(Math.floor(r.placeholders[0]!.mtimeMs))
    await utimes(p, fixed, fixed)
    const record = [{ path: p, mtimeMs: (await stat(p)).mtimeMs }]

    await writeFile(p, 'bytes')
    await utimes(p, fixed, fixed)
    // The precondition IS the setup: the row is only about the size guard
    // if the mtime really did come back unchanged.
    expect((await stat(p)).mtimeMs).toBe(record[0]!.mtimeMs)
    expect((await stat(p)).size).toBeGreaterThan(0)

    expect(await sweepPlaceholders(record)).toEqual([])
    expect(await kind(p)).toBe('file')
  })

  it('a placeholder the task replaced with a directory stays', async () => {
    const r = await requestFor(['dist'])
    await rm(path.join(dir, 'dist'))
    await mkdir(path.join(dir, 'dist'))
    expect(await sweepPlaceholders(r.placeholders)).toEqual([])
    expect(await kind(path.join(dir, 'dist'))).toBe('dir')
  })

  it('the hint names the grant as the task spelled it and the directory spelling', () => {
    const line = untouchedPlaceholderLine(dir, path.join(dir, 'dist'))
    expect(line).toContain('write grant `dist` named nothing on disk')
    expect(line).toContain('spell the grant `dist/`')
  })
})
