// The task environment over seeded random host environments and configs,
// against an oracle written from docs/schema.md § ExecEnv and
// docs/caching.md step 7 alone, not from src/exec/env.ts. env.test.ts holds
// the named cases and the end-to-end allowlist; this file holds the laws
// over the space: the child sees exactly the three layers (allowlist, then
// passThrough, then define) plus FORCE_COLOR and the bin prefix, nothing
// of the host leaks, and the key moves iff a `cache.inputs.env` value or
// the config moves, never for a value the child alone gets.

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildIsolatedEnv } from '../src/exec/env.js'
import { runCommand } from '../src/exec/runner.js'
import { foldKey } from '../src/cache/key-fold.js'
import type { CacheLayer } from '../src/cache/index.js'
import { computeTaskHash, createHashCache } from '../src/orchestrator/index.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { rng } from './helpers/rng.js'

// Typed from the docs, not imported: the oracle must not agree by reading
// the constant it judges.
const DOC_ESSENTIALS = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  'NODE_OPTIONS',
  'COREPACK_HOME',
  'PNPM_HOME',
]

const CHARS = ['a', 'Z', '0', '=', ' ', '\n', '\r', '\t', 'é', '漢', '😀', '"', "'", '$', '\\', ':']
// Names a host can hold; the last three are no shell identifier, so only
// the host and `cache.inputs.env` may name them.
const HOST_ONLY = ['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'PS1', 'a.b', 'X-Y', 'ünï']
const IDENTS = ['FOO', 'BAR_1', '_baz', 'NODE_ENV', 'VITE_URL', 'q']

type Rand = () => number
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const subset = <T>(r: Rand, xs: readonly T[], p: number): T[] => xs.filter(() => r() < p)

function value(r: Rand): string {
  let s = ''
  const n = Math.floor(r() * 7)
  for (let i = 0; i < n; i++) s += pick(r, CHARS)
  return s
}

function hostEnv(r: Rand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...DOC_ESSENTIALS, ...HOST_ONLY, ...IDENTS]) {
    const roll = r()
    if (roll < 0.5) env[name] = value(r)
    // `process.env` never holds one, but the type allows it: an undefined
    // entry is unset.
    else if (roll < 0.55) env[name] = undefined
  }
  return env
}

interface Config {
  passThrough: string[]
  define: Record<string, string>
  binPaths: string[]
}

function config(r: Rand): Config {
  const names = [...IDENTS, ...DOC_ESSENTIALS, 'SSH_AUTH_SOCK', 'GITHUB_TOKEN']
  const define: Record<string, string> = {}
  for (const n of subset(r, names, 0.15)) define[n] = value(r)
  const bins = ['/ws/p/node_modules/.bin', '/ws/node_modules/.bin', '/odd:dir/.bin', '/ü n/.bin']
  return {
    passThrough: subset(r, names, 0.25),
    define,
    binPaths: r() < 0.3 ? [] : subset(r, bins, 0.6),
  }
}

function oracle(host: NodeJS.ProcessEnv, c: Config): Record<string, string> {
  const out = new Map<string, string>()
  const fromHost = (n: string): void => {
    const v = host[n]
    if (v !== undefined) out.set(n, v)
  }
  DOC_ESSENTIALS.forEach(fromHost)
  c.passThrough.forEach(fromHost)
  for (const [n, v] of Object.entries(c.define)) out.set(n, v)
  if (!out.has('FORCE_COLOR') && (out.get('NO_COLOR') ?? '') === '') out.set('FORCE_COLOR', '1')
  const bins = c.binPaths.filter((d) => !d.includes(':'))
  if (bins.length > 0) {
    const prior = out.get('PATH') ?? ''
    out.set('PATH', [...bins, ...(prior === '' ? [] : [prior])].join(':'))
  }
  return Object.fromEntries(out)
}

const SEEDS = 400

describe('the child environment, over random hosts and configs', () => {
  it('is the documented layering exactly, and leaks nothing else of the host', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const host = hostEnv(r)
      const c = config(r)
      const before = JSON.stringify(host)
      const got = buildIsolatedEnv({ ...c, source: host })
      expect({ seed, env: got }).toEqual({ seed, env: oracle(host, c) })
      // A key holding undefined is a toEqual pass and a different environ.
      expect(Object.values(got).every((v) => typeof v === 'string')).toBe(true)

      const allowed = new Set([...DOC_ESSENTIALS, ...c.passThrough, ...Object.keys(c.define)])
      for (const name of Object.keys(got))
        expect({ seed, name, ok: allowed.has(name) }).toEqual({ seed, name, ok: true })
      for (const name of HOST_ONLY) {
        if (!c.passThrough.includes(name) && !(name in c.define)) expect(name in got).toBe(false)
      }

      expect(JSON.stringify(host)).toBe(before)
      expect(buildIsolatedEnv({ ...c, source: host })).toEqual(got)
    }
  })

  it("a value with '=', a newline and non-ASCII reaches the child byte-exact", async () => {
    const tricky = 'a=b==\nline two\r\n\tü漢😀 $HOME \\n\n'
    const env = buildIsolatedEnv({
      passThrough: ['FOO'],
      define: { BAR: tricky },
      source: { PATH: process.env['PATH'], FOO: `=${tricky}` },
    })
    const res = await runCommand({
      command: 'printf "%s|%s" "$FOO" "$BAR"',
      cwd: os.tmpdir(),
      env,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe(`=${tricky}|${tricky}`)
  })
})

describe('the key, over random hosts and configs', () => {
  const projectDir = path.join(os.tmpdir(), 'vx-env-prop-never-created')
  const cache = {
    key: (input: Parameters<CacheLayer['key']>[0]) =>
      foldKey(
        input,
        () => Promise.reject(new Error('no file input')),
        (f) => f,
      ),
  } as unknown as CacheLayer
  const KEYED_POOL = [...IDENTS, ...HOST_ONLY, 'NODE_OPTIONS', 'CI']

  interface Scenario {
    host: NodeJS.ProcessEnv
    c: Config
    keyed: string[]
  }

  // The documented key, as a value: the config as written (define values
  // included, passThrough names but not their values) and each
  // `cache.inputs.env` name with its host value, unset apart from empty.
  const signature = (s: Scenario): string =>
    JSON.stringify([
      s.c.passThrough,
      s.c.define,
      [...s.keyed].sort().map((n) => (s.host[n] === undefined ? [n] : [n, s.host[n]])),
    ])

  async function keyOf(s: Scenario): Promise<string> {
    const node = {
      id: 'p#build',
      projectName: 'p',
      projectDir,
      taskName: 'build',
      config: {
        exec: { command: 'build', env: { passThrough: s.c.passThrough, define: s.c.define } },
        cache: { inputs: { files: [], env: s.keyed }, outputs: { files: [] } },
      },
      deps: [],
      requested: true,
    } as unknown as TaskNode
    const hashCache = createHashCache()
    hashCache.packageJson.set(projectDir, Promise.resolve('pkg'))
    const names = new Set([...DOC_ESSENTIALS, ...HOST_ONLY, ...IDENTS])
    const saved = new Map([...names].map((n) => [n, process.env[n]]))
    try {
      for (const n of names) {
        const v = s.host[n]
        if (v === undefined) delete process.env[n]
        else process.env[n] = v
      }
      return await computeTaskHash({
        node,
        upstream: [],
        workspaceRoot: projectDir,
        workspaceFingerprint: 'fp',
        cache,
        nestedProjectDirs: [],
        hashCache,
      })
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n]
        else process.env[n] = v
      }
    }
  }

  // One edit to a scenario: a host value the key may or may not read, or
  // a define value. Unset and empty are distinct values of the edit.
  function mutate(r: Rand, s: Scenario): Scenario {
    const host = { ...s.host }
    const c = { ...s.c, define: { ...s.c.define } }
    const roll = r()
    const next = (old: string | undefined): string | undefined => {
      const v = r() < 0.25 ? undefined : r() < 0.2 ? '' : value(r)
      return v === old ? (old === undefined ? '' : undefined) : v
    }
    if (roll < 0.35 && s.keyed.length > 0) {
      const n = pick(r, s.keyed)
      // Half the edits add one character, often whitespace or '=': a key
      // that normalised a value would miss exactly that.
      host[n] = r() < 0.5 ? `${host[n] ?? ''}${pick(r, CHARS)}` : next(host[n])
    } else if (roll < 0.6 && s.c.passThrough.length > 0) {
      const n = pick(r, s.c.passThrough)
      host[n] = next(host[n])
    } else if (roll < 0.8 && Object.keys(c.define).length > 0) {
      const n = pick(r, Object.keys(c.define))
      c.define[n] = `${c.define[n]}${pick(r, CHARS)}`
    } else {
      const n = pick(r, [...DOC_ESSENTIALS, ...HOST_ONLY, ...IDENTS])
      host[n] = next(host[n])
    }
    for (const n of Object.keys(host)) if (host[n] === undefined) delete host[n]
    return { host, c, keyed: s.keyed }
  }

  it('moves iff a keyed value or the config moves, and is deterministic', async () => {
    let moved = 0
    let held = 0
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed)
      const a: Scenario = {
        host: hostEnv(r),
        c: config(r),
        keyed: subset(r, KEYED_POOL, 0.3),
      }
      for (const n of Object.keys(a.host)) if (a.host[n] === undefined) delete a.host[n]
      const b = mutate(r, a)
      // In turn: each call sets process.env for its own scenario.
      const ka = await keyOf(a)
      const ka2 = await keyOf(a)
      const kb = await keyOf(b)
      expect(ka2).toBe(ka)
      const same = signature(a) === signature(b)
      expect({ seed, same: ka === kb }).toEqual({ seed, same })
      if (same) held++
      else moved++
    }
    // Both arms drawn often enough to mean something.
    expect(moved).toBeGreaterThan(30)
    expect(held).toBeGreaterThan(30)
  })
})
