// The config evaluation cache (src/workspace/config-cache.ts): a provably
// pure config is served from its stored evaluation, keyed by every byte the
// evaluation could have read; anything that can observe the environment
// evaluates live.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import {
  CONFIG_EVAL_VERSION,
  configEvalKey,
  loadProjectConfig,
  stripLiterals,
  type ConfigEvalStore,
} from '../src/workspace/index.js'

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

const keyOf = (configPath: string, fingerprint = 'fp') =>
  Bun.file(configPath)
    .bytes()
    .then((bytes) => configEvalKey({ configPath, bytes, workspaceFingerprint: fingerprint }))

class MemoryStore implements ConfigEvalStore {
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
})
