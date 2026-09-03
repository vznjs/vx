// The config evaluation cache (src/workspace/config-cache.ts): a provably
// pure config is served from its stored evaluation, keyed by every byte the
// evaluation could have read; anything that can observe the environment
// evaluates live.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import {
  blobOidOf,
  configEvalKey,
  loadProjectConfig,
  loadProjectConfigs,
  type ConfigEvalStore,
} from '../src/workspace/index.js'
import { stripLiterals } from '../src/workspace/config-cache.js'
import { CONFIG_EVAL_VERSION } from '../src/workspace/config-cache.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-config-cache-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, text: string): Promise<string> {
  const full = path.join(root, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, text)
  return full
}

const keyedOf = (configPath: string, fingerprint = 'fp') =>
  Bun.file(configPath)
    .bytes()
    .then((bytes) => configEvalKey({ configPath, bytes, workspaceFingerprint: fingerprint }))
const keyOf = (configPath: string, fingerprint = 'fp') =>
  keyedOf(configPath, fingerprint).then((r) => (r === null ? null : r.key))

class MemoryStore implements ConfigEvalStore {
  batchGets = 0
  hashes = 0
  closures = new Map<string, string[]>()
  /** The identity `Cache.hashFile` returns for a sha1 repo: the git blob id of the bytes. */
  async hashFile(file: string): Promise<string> {
    this.hashes++
    return blobOidOf(await Bun.file(file).bytes())
  }
  getConfigClosures(paths: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const p of paths) {
      const c = this.closures.get(p)
      if (c !== undefined) out.set(p, c)
    }
    return out
  }
  putConfigClosure(path: string, files: readonly string[]): void {
    this.closures.set(path, [...files])
  }
  getConfigEvals(keys: readonly string[]): Map<string, string> {
    this.batchGets++
    const out = new Map<string, string>()
    for (const k of keys) {
      const v = this.rows.get(k)
      if (v !== undefined) out.set(k, v)
    }
    return out
  }
  rows = new Map<string, string>()
  puts = 0
  getConfigEval(key: string): string | null {
    return this.rows.get(key) ?? null
  }
  putConfigEval(key: string, json: string): void {
    this.puts++
    this.rows.set(key, json)
  }
}

describe('configEvalKey', () => {
  it('keys a pure config on its bytes, its relative import closure and the fingerprint', async () => {
    const preset = await write('shared/preset.mjs', "export const cmd = 'echo one'\n")
    const cfg = await write(
      'packages/a/vx.config.mjs',
      "import { cmd } from '../../shared/preset.mjs'\nexport default { tasks: { build: { exec: { command: cmd } } } }\n",
    )
    const k1 = await keyOf(cfg)
    expect(k1).not.toBeNull()
    expect(await keyOf(cfg)).toBe(k1)
    // A different fingerprint (lockfile moved) is a different key.
    expect(await keyOf(cfg, 'other')).not.toBe(k1)
    // Editing the PRESET — a file the config never names in its own bytes —
    // moves the key. That is the whole point of the closure walk.
    await writeFile(preset, "export const cmd = 'echo two'\n")
    expect(await keyOf(cfg)).not.toBe(k1)
    expect(CONFIG_EVAL_VERSION).toBeGreaterThan(0)
    // The closure is the config first, then its imports in discovery order,
    // and an import with an explicit extension is indexable.
    const keyed = (await keyedOf(cfg))!
    expect(keyed.closure).toEqual([cfg, await realpath(preset)]) // imports resolve to real paths
    expect(keyed.indexable).toBe(true)
  })

  it('allows the @vzn/vx import, and nothing else that is not relative', async () => {
    const pure = await write(
      'packages/p/vx.config.mjs',
      "import { defineProject } from '@vzn/vx'\nexport default defineProject({ tasks: { build: { exec: { command: 'x' } } } })\n",
    )
    expect(await keyOf(pure)).not.toBeNull()
    for (const spec of ['node:os', 'bun:sqlite', 'some-preset-package', '/abs/file.mjs']) {
      const cfg = await write(
        'packages/q/vx.config.mjs',
        `import x from '${spec}'\nexport default { tasks: {} }\n`,
      )
      expect({ spec, key: await keyOf(cfg) }).toEqual({ spec, key: null })
    }
  })

  it.each([
    'process.env.CI',
    'Bun.env.X',
    'globalThis.foo',
    'new Date().getFullYear()',
    'Math.random()',
    'import.meta.dir',
    "await import('./x.mjs')",
    "require('./x.cjs')",
    "fetch('http://x')",
    // Every spelling below was CACHED AS PURE on 2026-09-03 and evaluated to
    // a machine-dependent value: an identifier escape the word list cannot
    // see, the two live globalThis aliases Bun exposes, and a second clock.
    '\\u0070rocess.env.HOME',
    "global['proc' + 'ess'].env.HOME",
    "self['proc' + 'ess'].env.HOME",
    'Temporal.Now.instant().epochMilliseconds',
  ])('refuses to cache a config that mentions %s', async (expr) => {
    const cfg = await write(
      'packages/r/vx.config.mjs',
      `const v = String(${expr})\nexport default { tasks: { t: { exec: { command: 'echo ' + v } } } }\n`,
    )
    expect(await keyOf(cfg)).toBeNull()
  })

  it('refuses when the impurity sits in an imported file, not the config', async () => {
    await write('shared/env.mjs', 'export const mode = process.env.MODE ?? "dev"\n')
    const cfg = await write(
      'packages/s/vx.config.mjs',
      "import { mode } from '../../shared/env.mjs'\nexport default { tasks: { t: { exec: { command: 'echo ' + mode } } } }\n",
    )
    expect(await keyOf(cfg)).toBeNull()
  })

  it('refuses an unresolvable relative import rather than keying on a partial closure', async () => {
    const cfg = await write(
      'packages/u/vx.config.mjs',
      "import { x } from './missing.mjs'\nexport default { tasks: {} }\n",
    )
    expect(await keyOf(cfg)).toBeNull()
  })
})

describe('stripLiterals', () => {
  it('removes strings and comments but keeps template expressions', () => {
    const src =
      'const a = \'process.env\' // Date\nconst b = `x${y.z}w` /* fetch */\nconst c = "q"\n'
    expect(stripLiterals(src)).toBe('const a =   \nconst b =  y.z  \nconst c =  \n')
  })
  it('bails on a bare slash (regex or division) rather than guess', () => {
    expect(stripLiterals("const r = /'/; process.env.X")).toBeNull()
    expect(stripLiterals('const d = a / b')).toBeNull()
  })
  it('bails on an unterminated literal', () => {
    expect(stripLiterals("const s = 'open")).toBeNull()
    expect(stripLiterals('const t = `open ${x}')).toBeNull()
    expect(stripLiterals('/* open')).toBeNull()
  })
})

describe('configEvalKey ignores impure-looking text inside literals', () => {
  it('caches a config whose COMMAND mentions process, and refuses one whose CODE does', async () => {
    const inString = await write(
      'packages/x/vx.config.mjs',
      'export default { tasks: { t: { exec: { command: \'node -e "process.exit(0)"\' } } } } // Date\n',
    )
    expect(await keyOf(inString)).not.toBeNull()
    const inTemplate = await write(
      'packages/y/vx.config.mjs',
      'export default { tasks: { t: { exec: { command: `echo ${process.env.X}` } } } }\n',
    )
    expect(await keyOf(inTemplate)).toBeNull()
  })
})

describe('loadProjectConfig with an eval cache', () => {
  it('stores a validated evaluation and serves the next load from it without evaluating', async () => {
    const cfg = await write(
      'packages/a/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'echo hi' } } } }\n",
    )
    const store = new MemoryStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    const first = await loadProjectConfig(cfg, { evalCache })
    expect(first.tasks?.build?.exec?.command).toBe('echo hi')
    expect(store.puts).toBe(1)
    // Prove the second load is served from the store and not evaluated:
    // replace the stored JSON with a DIFFERENT config under the same key.
    const [key] = [...store.rows.keys()]
    store.rows.set(key!, JSON.stringify({ tasks: { build: { exec: { command: 'from-cache' } } } }))
    const second = await loadProjectConfig(cfg, { evalCache })
    expect(second.tasks?.build?.exec?.command).toBe('from-cache')
    expect(store.puts).toBe(1)
  })

  // The batched loader is what `prepareRun` calls: one store lookup for a
  // round's keys, misses evaluated in order. Same contract as one by one.
  it('loadProjectConfigs serves hits from ONE batched lookup and evaluates only the misses', async () => {
    const a = await write(
      'packages/a/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'a' } } } }\n",
    )
    const b = await write(
      'packages/b/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'b' } } } }\n",
    )
    const store = new MemoryStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    await loadProjectConfig(a, { evalCache }) // a is stored; b is not
    expect(store.puts).toBe(1)
    const [keyA] = [...store.rows.keys()]
    store.rows.set(
      keyA!,
      JSON.stringify({ tasks: { build: { exec: { command: 'a-from-cache' } } } }),
    )
    const before = store.batchGets
    const [ca, cb] = await loadProjectConfigs([a, b], { evalCache })
    expect(ca?.tasks?.build?.exec?.command).toBe('a-from-cache') // served, not evaluated
    expect(cb?.tasks?.build?.exec?.command).toBe('b') // evaluated and stored
    expect(store.puts).toBe(2)
    expect(store.batchGets).toBe(before + 1) // one lookup for the round
  })

  it('a round with two broken configs names the FIRST in the given order, as one-by-one did', async () => {
    const ok = await write(
      'packages/ok/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'x' } } } }\n",
    )
    const bad1 = await write('packages/bad1/vx.config.mjs', 'export default { tasks: 42 }\n')
    const bad2 = await write('packages/bad2/vx.config.mjs', 'export default { tasks: 43 }\n')
    const evalCache = { store: new MemoryStore(), workspaceFingerprint: 'fp' }
    await expect(loadProjectConfigs([ok, bad1, bad2], { evalCache })).rejects.toThrow(/bad1/)
    await expect(loadProjectConfigs([ok, bad2, bad1], { evalCache })).rejects.toThrow(/bad2/)
  })

  // The warm fast path: once a config's closure is indexed, the next load
  // keys it from per-file identities (a hash per closure file, no scan) and
  // serves the stored evaluation. A preset edit changes that preset's
  // identity, so the fast key misses and the slow path re-evaluates.
  it('keys a warm load from the indexed closure, and a preset edit still misses', async () => {
    const preset = await write('shared/preset.mjs', "export const cmd = 'echo one'\n")
    const cfg = await write(
      'packages/a/vx.config.mjs',
      "import { cmd } from '../../shared/preset.mjs'\nexport default { tasks: { build: { exec: { command: cmd } } } }\n",
    )
    const store = new MemoryStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    const first = await loadProjectConfigs([cfg], { evalCache })
    expect(first[0]?.tasks?.build?.exec?.command).toBe('echo one')
    expect(store.closures.get(cfg)).toEqual([cfg, await realpath(preset)]) // indexed on the miss
    const [key] = [...store.rows.keys()]
    // Prove the second load is served from the store: replace the stored
    // JSON under the same key.
    store.rows.set(key!, JSON.stringify({ tasks: { build: { exec: { command: 'from-cache' } } } }))
    const puts = store.puts
    const second = await loadProjectConfigs([cfg], { evalCache })
    expect(second[0]?.tasks?.build?.exec?.command).toBe('from-cache')
    expect(store.puts).toBe(puts) // nothing evaluated
    // Now edit the PRESET: its identity changes, the fast key misses, the
    // slow path evaluates the new value and re-indexes.
    await writeFile(preset, "export const cmd = 'echo two'\n")
    const third = await loadProjectConfigs([cfg], { evalCache })
    expect(third[0]?.tasks?.build?.exec?.command).toBe('echo two')
    expect(store.puts).toBe(puts + 1)
  })

  it('a deleted closure file cannot be served from the index: the fast key misses and the live load fails', async () => {
    const preset = await write('shared/gone.mjs', "export const cmd = 'echo here'\n")
    const cfg = await write(
      'packages/c/vx.config.mjs',
      "import { cmd } from '../../shared/gone.mjs'\nexport default { tasks: { build: { exec: { command: cmd } } } }\n",
    )
    const store = new MemoryStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    await loadProjectConfigs([cfg], { evalCache })
    expect(store.closures.has(cfg)).toBe(true)
    await rm(preset)
    // The stored evaluation still exists under the old key, but the fast key
    // cannot be built (the identity of a missing file throws), and the live
    // load fails on the import — never the stale 'echo here'.
    await expect(loadProjectConfigs([cfg], { evalCache })).rejects.toThrow()
  })

  it('an extensionless relative import is never indexed (a new file could change its resolution)', async () => {
    await write('shared/loose.mjs', "export const cmd = 'echo loose'\n")
    const cfg = await write(
      'packages/b/vx.config.mjs',
      "import { cmd } from '../../shared/loose'\nexport default { tasks: { build: { exec: { command: cmd } } } }\n",
    )
    const store = new MemoryStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    const [c] = await loadProjectConfigs([cfg], { evalCache })
    expect(c?.tasks?.build?.exec?.command).toBe('echo loose')
    expect(store.puts).toBe(1) // still cached by the slow path …
    expect(store.closures.has(cfg)).toBe(false) // … but never indexed
    expect((await keyedOf(cfg))?.indexable).toBe(false)
  })

  it('never stores an impure config, and `fresh` bypasses the cache entirely', async () => {
    const impure = await write(
      'packages/b/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'echo ' + (process.env.X ?? '') } } } }\n",
    )
    const store = new MemoryStore()
    await loadProjectConfig(impure, { evalCache: { store, workspaceFingerprint: 'fp' } })
    expect(store.puts).toBe(0)
    const pure = await write(
      'packages/c/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'echo hi' } } } }\n",
    )
    await loadProjectConfig(pure, { fresh: true, evalCache: { store, workspaceFingerprint: 'fp' } })
    expect(store.puts).toBe(0)
  })

  it('a malformed config is refused before anything is stored', async () => {
    const bad = await write(
      'packages/d/vx.config.mjs',
      'export default { tasks: { t: { exec: 5 } } }\n',
    )
    const store = new MemoryStore()
    await expect(
      loadProjectConfig(bad, { evalCache: { store, workspaceFingerprint: 'fp' } }),
    ).rejects.toThrow()
    expect(store.puts).toBe(0)
  })
})

describe('Cache as a ConfigEvalStore', () => {
  it('round-trips through cache.db and honours the local read/write axes', () => {
    const rw = new Cache(path.join(root, 'rw'))
    expect(rw.getConfigEval('k')).toBeNull()
    rw.putConfigEval('k', '{"tasks":{}}')
    expect(rw.getConfigEval('k')).toBe('{"tasks":{}}')
    rw.close()
    const reopened = new Cache(path.join(root, 'rw'))
    expect(reopened.getConfigEval('k')).toBe('{"tasks":{}}')
    reopened.close()

    const noWrite = new Cache(path.join(root, 'nw'), { read: true, write: false })
    noWrite.putConfigEval('k', '{}')
    expect(noWrite.getConfigEval('k')).toBeNull()
    noWrite.close()
    const noRead = new Cache(path.join(root, 'nr'), { read: false, write: true })
    noRead.putConfigEval('k', '{}')
    expect(noRead.getConfigEval('k')).toBeNull()
    noRead.close()
  })
  it('the closure index honours the local read/write axes too', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-cc-axes-'))
    try {
      const wo = new Cache(dir, { read: true, write: false })
      wo.putConfigClosure('/p/vx.config.mjs', ['/p/vx.config.mjs'])
      expect(wo.getConfigClosures(['/p/vx.config.mjs']).size).toBe(0) // nothing written
      wo.close()
      const rw = new Cache(dir)
      rw.putConfigClosure('/p/vx.config.mjs', ['/p/vx.config.mjs', '/p/preset.mjs'])
      expect(rw.getConfigClosures(['/p/vx.config.mjs']).get('/p/vx.config.mjs')).toEqual([
        '/p/vx.config.mjs',
        '/p/preset.mjs',
      ])
      rw.close()
      const ro = new Cache(dir, { read: false, write: true })
      expect(ro.getConfigClosures(['/p/vx.config.mjs']).size).toBe(0) // read gate
      ro.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
