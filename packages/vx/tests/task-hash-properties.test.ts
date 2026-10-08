// Seeded properties of the cache key, against an oracle that shares nothing
// with the fold. `task-hash-derive.test.ts` pins each contract by example;
// here random inputs ask the same questions everywhere at once:
//
//   - the fold (`foldKey`): two inputs share a key exactly when their
//     canonical forms agree. The canonical form is built here from what the
//     key MEANS (upstream as a set, files as a sorted rel → digest list, an
//     absent optional section as an empty one), so a fold that drops,
//     truncates or re-frames a part collides two forms that differ, and one
//     that keys on an order or a provenance splits two that agree;
//   - boundary shifts: the same characters split at another place, across
//     every pair and list boundary the fold has, `\0` and `=` included in
//     the strings, give another key;
//   - `computeTaskHash` over random resolved configs: each key-relevant edit
//     moves the key, and `exec.remote`, upstream order, the memo and a
//     structurally equal clone do not.
//
// Not claimed: config key ORDER. The config folds as `JSON.stringify`, so
// writing `cache` before `exec` (or reordering a glob list) is one false
// miss; item 983 declined sorting it for the warm-path cost.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Cache, type CacheKeyInput } from '../src/cache/index.js'
import { foldKey } from '../src/cache/key-fold.js'
import type { TaskConfig } from '../src/config.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { computeTaskHash, createHashCache } from '../src/orchestrator/task-hash.js'
import { rng } from './helpers/rng.js'

const W = '/w'
// Small alphabets so boundaries line up often; `\0` and `=` are the
// delimiters a fold could lean on, `:` the label separator.
const VALUE_CHARS = ['a', 'b', '\0', '=', ':', 'é']
const NAME_CHARS = ['a', 'b', '=', ':', 'é']

type Rand = () => number
const int = (r: Rand, n: number): number => Math.floor(r() * n)
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[int(r, xs.length)]!
const str = (r: Rand, chars: readonly string[], max = 3): string =>
  Array.from({ length: int(r, max + 1) }, () => pick(r, chars)).join('')
const list = <T>(r: Rand, max: number, f: () => T): T[] =>
  Array.from({ length: int(r, max + 1) }, f)
function shuffle<T>(r: Rand, xs: readonly T[]): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

interface Drawn {
  input: CacheKeyInput
  /** The digest each input file holds, rel → digest. */
  digests: Map<string, string>
}

// Names hold no NUL: the schema refuses one in an env name, a runtime
// command and a plugin part name, and no path can carry one.
function draw(r: Rand, size = 3): Drawn {
  const s = (chars: readonly string[], max = 3): string => str(r, chars, Math.min(max, size))
  const l = <T>(max: number, f: () => T): T[] => list(r, Math.min(max, size), f)
  const digests = new Map<string, string>()
  for (const rel of l(3, () => `${s(NAME_CHARS, 2)}${int(r, 3)}`)) {
    digests.set(rel, s(VALUE_CHARS, 2))
  }
  const pair = (): [string, string] => [s(NAME_CHARS), s(VALUE_CHARS)]
  const input: CacheKeyInput = {
    taskId: s(VALUE_CHARS),
    taskConfigHash: s(VALUE_CHARS),
    projectPackageJsonHash: s(VALUE_CHARS),
    workspaceFingerprint: s(VALUE_CHARS),
    envValues: l(2, () => [s(NAME_CHARS), r() < 0.25 ? undefined : s(VALUE_CHARS)]),
    upstreamHashes: l(3, () => s(VALUE_CHARS)),
    inputFiles: [...digests.keys()].map((rel) => `${W}/${rel}`),
    workspaceRoot: W,
  }
  // An empty optional section is drawn absent half the time.
  const forwardArgs = l(3, () => s(VALUE_CHARS))
  if (forwardArgs.length > 0 || r() < 0.5) input.forwardArgs = forwardArgs
  const runtimeValues = l(2, pair)
  if (runtimeValues.length > 0 || r() < 0.5) input.runtimeValues = runtimeValues
  const workspaceRuntimeValues = l(2, pair)
  if (workspaceRuntimeValues.length > 0 || r() < 0.5) {
    input.workspaceRuntimeValues = workspaceRuntimeValues
  }
  const pluginParts = l(2, pair)
  if (pluginParts.length > 0 || r() < 0.5) input.pluginParts = pluginParts
  return { input, digests }
}

/** What the key means, written without the fold. */
function canonical(i: CacheKeyInput, digests: ReadonlyMap<string, string>): string {
  const files = i.inputFiles
    .map((f) => f.slice(W.length + 1))
    .sort()
    .map((rel) => [rel, digests.get(rel)!])
  return JSON.stringify([
    i.taskId,
    i.taskConfigHash,
    i.projectPackageJsonHash,
    i.workspaceFingerprint,
    i.forwardArgs ?? [],
    i.envValues.map(([n, v]) => (v === undefined ? [n] : [n, v])),
    i.runtimeValues ?? [],
    i.workspaceRuntimeValues ?? [],
    [...i.upstreamHashes].sort(),
    i.pluginParts ?? [],
    files,
  ])
}

/**
 * The fold, its file digests answered from `digests`: every file through
 * `hashFile`, or (`viaMap`) the given share of them through the caller's OID
 * map, the way a run's git index hands them over.
 */
function fold(d: Drawn, viaMap?: (rel: string) => boolean): Promise<string> {
  const input: CacheKeyInput = { ...d.input }
  if (viaMap !== undefined) {
    input.fileHashes = new Map(
      [...d.digests].filter(([rel]) => viaMap(rel)).map(([rel, h]) => [`${W}/${rel}`, h]),
    )
  }
  return foldKey(
    input,
    async (f) => d.digests.get(f.slice(W.length + 1))!,
    (f) => f.slice(W.length + 1),
  )
}

describe('the fold keys exactly what the key means', () => {
  it('equal canonical forms share a key, different ones never do', async () => {
    const r = rng(0x5eed)
    const byCanon = new Map<string, string>()
    const byKey = new Map<string, string>()
    for (let n = 0; n < 1500; n++) {
      // Small draws put near neighbours ('' and 'a', one list and none)
      // side by side.
      const d = draw(r, n % 4)
      const c = canonical(d.input, d.digests)
      const k = await fold(d)
      // Deterministic.
      expect(await fold(d)).toBe(k)
      const seenKey = byCanon.get(c)
      if (seenKey !== undefined) expect(k).toBe(seenKey)
      const seenCanon = byKey.get(k)
      if (seenCanon !== undefined) expect(c).toBe(seenCanon)
      byCanon.set(c, k)
      byKey.set(k, c)
    }
    // CONTROL: equal forms recur (the empty draws at least), so the first
    // direction runs; the next row holds it for non-trivial inputs.
    expect(byCanon.size).toBeLessThan(1500)
    expect(byCanon.size).toBeGreaterThan(1000)
  })

  it('order, provenance and side channels the key does not mean keep it', async () => {
    const r = rng(0xbeef)
    for (let n = 0; n < 400; n++) {
      const d = draw(r)
      const base = await fold(d)
      const twin: Drawn = {
        digests: d.digests,
        input: {
          ...d.input,
          upstreamHashes: shuffle(r, d.input.upstreamHashes),
          inputFiles: shuffle(r, d.input.inputFiles),
          upstreamIds: new Map(d.input.upstreamHashes.map((h) => [h, str(r, NAME_CHARS)])),
          upstreamGraft: d.input.upstreamHashes.map((h) => ({
            taskId: str(r, NAME_CHARS),
            hash: h,
            projectDir: W,
          })),
          captureInto: [],
        },
      }
      // Absent and empty are one section.
      if (d.input.forwardArgs?.length === 0) delete twin.input.forwardArgs
      if (d.input.pluginParts === undefined) twin.input.pluginParts = []
      const half = r() < 0.5
      expect(await fold(twin, () => r() < 0.5)).toBe(base)
      expect(await fold(twin, () => half)).toBe(base)
    }
  })

  it('the same characters split at another boundary give another key', async () => {
    const r = rng(0xb0d)
    let shifted = 0
    // Each case reads a drawn input as a list of adjacent strings and writes
    // it back with one boundary moved; `names` marks the parts that are
    // names, which keep no NUL.
    type Case = {
      read: (i: CacheKeyInput) => string[]
      write: (i: CacheKeyInput, parts: string[]) => CacheKeyInput
      names?: (parts: string[]) => boolean[]
    }
    const noNul = (xs: string[], at: boolean[]): boolean =>
      xs.every((x, j) => !at[j] || !x.includes('\0'))
    const pairs = (key: 'runtimeValues' | 'workspaceRuntimeValues' | 'pluginParts'): Case => ({
      read: (i) => (i[key] ?? []).flat(),
      write: (i, p) => ({
        ...i,
        [key]: Array.from({ length: p.length / 2 }, (_, j) => [p[2 * j]!, p[2 * j + 1]!]),
      }),
      names: (p) => p.map((_, j) => j % 2 === 0),
    })
    const cases: Case[] = [
      {
        read: (i) => [i.taskId, i.workspaceFingerprint, i.projectPackageJsonHash, i.taskConfigHash],
        write: (i, [t, w, p, c]) => ({
          ...i,
          taskId: t!,
          workspaceFingerprint: w!,
          projectPackageJsonHash: p!,
          taskConfigHash: c!,
        }),
      },
      {
        read: (i) => [...(i.forwardArgs ?? [])],
        write: (i, p) => ({ ...i, forwardArgs: p }),
      },
      {
        read: (i) => i.envValues.filter(([, v]) => v !== undefined).flat() as string[],
        write: (i, p) => ({
          ...i,
          envValues: Array.from({ length: p.length / 2 }, (_, j) => [p[2 * j]!, p[2 * j + 1]!]),
        }),
        names: (p) => p.map((_, j) => j % 2 === 0),
      },
      pairs('runtimeValues'),
      pairs('workspaceRuntimeValues'),
      pairs('pluginParts'),
      {
        read: (i) => [...i.upstreamHashes].sort(),
        write: (i, p) => ({ ...i, upstreamHashes: p }),
      },
    ]
    for (let n = 0; n < 1500; n++) {
      const d = draw(r)
      const c = pick(r, cases)
      const parts = c.read(d.input)
      if (parts.length < 2) continue
      const j = int(r, parts.length - 1)
      const joined = parts[j]! + parts[j + 1]!
      const cut = int(r, joined.length + 1)
      const moved = [...parts]
      moved[j] = joined.slice(0, cut)
      moved[j + 1] = joined.slice(cut)
      if (moved[j] === parts[j]) continue
      if (c.names !== undefined && !noNul(moved, c.names(moved))) continue
      // Sorted sections may re-sort the moved form back into the original.
      const after: Drawn = { digests: d.digests, input: c.write(d.input, moved) }
      const before: Drawn = { digests: d.digests, input: c.write(d.input, parts) }
      if (canonical(after.input, d.digests) === canonical(before.input, d.digests)) continue
      expect(await fold(after)).not.toBe(await fold(before))
      shifted++
    }
    // CONTROL: the skips leave most draws standing.
    expect(shifted).toBeGreaterThan(400)
  })

  it('a file name and its digest cannot trade characters', async () => {
    const r = rng(0xf11e)
    let shifted = 0
    for (let n = 0; n < 500; n++) {
      const rel = `${str(r, NAME_CHARS, 3)}${int(r, 3)}`
      const digest = str(r, VALUE_CHARS, 3)
      const joined = rel + digest
      const cut = int(r, joined.length + 1)
      const rel2 = joined.slice(0, cut)
      if (rel2 === rel || rel2 === '' || rel2.includes('\0')) continue
      const one = (rl: string, h: string): Drawn => ({
        digests: new Map([[rl, h]]),
        input: { ...draw(rng(n)).input, inputFiles: [`${W}/${rl}`] },
      })
      expect(await fold(one(rel2, joined.slice(cut)))).not.toBe(await fold(one(rel, digest)))
      shifted++
    }
    expect(shifted).toBeGreaterThan(200)
  })
})

describe('computeTaskHash over random resolved configs', () => {
  let root: string
  let cache: Cache
  const ENV = ['VX_KEYPROP_A', 'VX_KEYPROP_B']
  const saved = ENV.map((n) => process.env[n])

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vx-keyprop-'))
    writeFileSync(path.join(root, 'package.json'), '{"name":"pkg"}')
    cache = new Cache(path.join(root, '.vx-cache'))
  })
  afterAll(() => {
    cache.close()
    rmSync(root, { recursive: true, force: true })
    ENV.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n]
      else process.env[n] = saved[i]
    })
  })

  function config(r: Rand): TaskConfig {
    const exec: NonNullable<TaskConfig['exec']> = { command: `cmd ${str(r, NAME_CHARS)}` }
    if (r() < 0.5) exec.env = { define: { D: str(r, NAME_CHARS) } }
    if (r() < 0.5) exec.timeout = 1 + int(r, 100)
    if (r() < 0.5) exec.retries = int(r, 4)
    return {
      ...(r() < 0.5 ? { description: str(r, NAME_CHARS) } : {}),
      exec,
      cache: {
        inputs: { files: [], ...(r() < 0.5 ? { env: [...ENV] } : {}) },
        outputs: { files: [] },
      },
    }
  }

  function upstream(hashes: readonly string[]): TaskOutcome[] {
    return hashes.map((hash, i) => ({
      node: {
        id: `dep${i}#build`,
        projectName: `dep${i}`,
        projectDir: root,
        taskName: 'build',
        config: { exec: { command: 'noop' } },
        deps: [],
        requested: false,
      },
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash,
    }))
  }

  interface Case {
    cfg: TaskConfig
    up: string[]
    forward: string[]
    requested: boolean
  }

  async function key(c: Case, opts: { hashCache?: boolean; c?: Cache } = {}): Promise<string> {
    const node: TaskNode = {
      id: 'pkg#build',
      projectName: 'pkg',
      projectDir: root,
      taskName: 'build',
      config: c.cfg,
      deps: [],
      requested: c.requested,
    }
    return await computeTaskHash({
      node,
      upstream: upstream(c.up),
      workspaceRoot: root,
      workspaceFingerprint: 'fp',
      cache: opts.c ?? cache,
      nestedProjectDirs: [],
      forwardArgs: c.forward,
      ...(opts.hashCache === true ? { hashCache: createHashCache() } : {}),
    })
  }

  // Each edit changes one part the key must answer for; a `null` is an edit
  // that does not apply to this draw.
  const edits: Record<string, (c: Case, r: Rand) => Case | null> = {
    command: (c) => ({
      ...c,
      cfg: { ...c.cfg, exec: { ...c.cfg.exec!, command: `${c.cfg.exec!.command}x` } },
    }),
    define: (c) =>
      c.cfg.exec!.env?.define === undefined
        ? null
        : {
            ...c,
            cfg: {
              ...c.cfg,
              exec: { ...c.cfg.exec!, env: { define: { D: `${c.cfg.exec!.env.define.D}x` } } },
            },
          },
    timeout: (c) => ({
      ...c,
      cfg: { ...c.cfg, exec: { ...c.cfg.exec!, timeout: (c.cfg.exec!.timeout ?? 0) + 1 } },
    }),
    retries: (c) => ({
      ...c,
      cfg: { ...c.cfg, exec: { ...c.cfg.exec!, retries: (c.cfg.exec!.retries ?? 0) + 1 } },
    }),
    description: (c) => ({ ...c, cfg: { ...c.cfg, description: `${c.cfg.description ?? ''}x` } }),
    upstream: (c, r) => {
      if (c.up.length === 0) return null
      const up = [...c.up]
      const j = int(r, up.length)
      up[j] = `${up[j]}x`
      return { ...c, up }
    },
    'forward args': (c) => (c.requested ? { ...c, forward: [...c.forward, 'x'] } : null),
  }

  function draws(seed: number, count: number): Array<{ c: Case; r: Rand }> {
    const r = rng(seed)
    return Array.from({ length: count }, () => ({
      c: {
        cfg: config(r),
        up: list(r, 3, () => `h${str(r, NAME_CHARS)}`),
        forward: list(r, 2, () => str(r, NAME_CHARS)),
        requested: r() < 0.5,
      },
      r,
    }))
  }

  it('each key-relevant edit moves the key', async () => {
    const applied = new Map<string, number>()
    for (const { c, r } of draws(0xc0f, 40)) {
      const base = await key(c)
      expect(await key(c)).toBe(base)
      for (const [what, edit] of Object.entries(edits)) {
        const edited = edit(c, r)
        if (edited === null) continue
        // Equal JSON is the same config: an edit that cannot change it is no edit.
        if (JSON.stringify(edited) === JSON.stringify(c)) continue
        expect({ what, key: await key(edited) }).not.toEqual({ what, key: base })
        applied.set(what, (applied.get(what) ?? 0) + 1)
      }
    }
    // CONTROL: every edit ran on a fair share of the draws.
    expect([...applied.keys()].sort()).toEqual(Object.keys(edits).sort())
    for (const n of applied.values()) expect(n).toBeGreaterThan(10)
  })

  it('a cache.inputs.env value moves the key only for the task that declares it', async () => {
    for (const { c } of draws(0xe7, 20)) {
      process.env.VX_KEYPROP_A = 'one'
      const before = await key(c)
      process.env.VX_KEYPROP_A = 'one='
      const after = await key(c)
      if (c.cfg.cache!.inputs.env === undefined) expect(after).toBe(before)
      else expect(after).not.toBe(before)
    }
  })

  it('exec.remote, upstream order, the memo and a clone keep the key', async () => {
    for (const { c, r } of draws(0x5a3e, 40)) {
      const base = await key(c)
      // `remote` at a random place in `exec`'s own key order.
      const entries = Object.entries(c.cfg.exec!)
      entries.splice(int(r, entries.length + 1), 0, ['remote', pick(r, [true, false, 'only'])])
      const remote = { ...c, cfg: { ...c.cfg, exec: Object.fromEntries(entries) as never } }
      expect(await key(remote)).toBe(base)
      expect(await key({ ...c, up: shuffle(r, c.up) })).toBe(base)
      expect(await key(c, { hashCache: true })).toBe(base)
      expect(await key(structuredClone(c))).toBe(base)
      // Forward args reach only a task the run asked for.
      if (!c.requested) expect(await key({ ...c, forward: [...c.forward, 'x'] })).toBe(base)
    }
  })

  it('package.json bytes move the key; the same bytes again restore it', async () => {
    const r = rng(0x9a9)
    const c = draws(0x9a9, 1)[0]!.c
    let prev: string | undefined
    let prevBody: string | undefined
    for (let n = 0; n < 12; n++) {
      // Same length every time: the change is in the bytes, not the size.
      const body = `{"name":"pkg","v":"${pick(r, ['ab', 'ba', 'aa', 'bb'])}"}`
      writeFileSync(path.join(root, 'package.json'), body)
      // A fresh store per read: `hashFile` memoizes on stat, and a same-size
      // rewrite inside one stamp is the memo's question, not this one's.
      const c2 = new Cache(path.join(root, `.vx-cache-${n}`))
      const k = await key(c, { c: c2 })
      c2.close()
      if (prevBody !== undefined) {
        if (body === prevBody) expect(k).toBe(prev!)
        else expect(k).not.toBe(prev!)
      }
      prev = k
      prevBody = body
    }
  })
})

describe('input file bytes, read from disk', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'vx-keyprop-files-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it('a byte moved in any input moves the key; the workspace path never does', async () => {
    const r = rng(0xf1)
    const cache = new Cache(path.join(scratch, '.vx-cache'))
    try {
      for (let n = 0; n < 40; n++) {
        const files = new Map(list(r, 3, () => [`f${int(r, 4)}.txt`, str(r, VALUE_CHARS, 4)]))
        if (files.size === 0) continue
        const rels = [...files.keys()]
        const flip = pick(r, rels)
        const old = files.get(flip)!
        const flipped = old === '' ? 'a' : `${old.slice(0, -1)}${old.endsWith('a') ? 'b' : 'a'}`
        // Three trees: the drawn one, a copy of it at another path, and the
        // copy with one file's bytes changed. Fresh paths, so no memo row.
        const tree = (name: string, over?: [string, string]): string => {
          const dir = path.join(scratch, `${n}-${name}`)
          mkdirSync(dir)
          for (const [rel, body] of files) {
            writeFileSync(path.join(dir, rel), over?.[0] === rel ? over[1] : body)
          }
          return dir
        }
        const k = async (dir: string): Promise<string> =>
          await cache.key({
            taskId: 'p#t',
            taskConfigHash: 'cfg',
            projectPackageJsonHash: 'pkg',
            workspaceFingerprint: 'fp',
            envValues: [],
            upstreamHashes: [],
            workspaceRoot: dir,
            inputFiles: rels.map((rel) => path.join(dir, rel)),
          })
        const a = await k(tree('a'))
        expect(await k(tree('b'))).toBe(a)
        expect(await k(tree('c', [flip, flipped]))).not.toBe(a)
      }
    } finally {
      cache.close()
    }
  })
})
