// The config evaluation cache (src/workspace/config-cache.ts): a provably
// pure config is served from its stored evaluation, keyed by every byte the
// evaluation could have read; anything that can observe the environment
// evaluates live.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { xxh3 } from '../src/util/index.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import {
  blobOidOf,
  configEvalKey,
  configEvalKeyFromClosure,
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

/** The store with the batched writes: a round lands in one call per table; `puts` still counts entries. */
class BatchedStore extends MemoryStore {
  batchEvalPuts = 0
  batchClosurePuts = 0
  bytesHashes = 0
  putConfigEvals(entries: ReadonlyArray<readonly [string, string]>): void {
    this.batchEvalPuts++
    for (const [k, json] of entries) this.putConfigEval(k, json)
  }
  putConfigClosures(entries: ReadonlyArray<readonly [string, readonly string[]]>): void {
    this.batchClosurePuts++
    for (const [p, files] of entries) this.putConfigClosure(p, files)
  }
  hashBytes(bytes: Uint8Array): string {
    this.bytesHashes++
    return blobOidOf(bytes)
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

  it('refuses a non-relative import even when it RESOLVES outside node_modules (item 653)', async () => {
    // The row above names specifiers that do not resolve, so resolution
    // refused them and the relative-only rule had no witness. These two
    // resolve to a pure file no node_modules segment names: an absolute
    // path, and a bare package linked in from the workspace.
    const preset = await write('shared/linked/index.mjs', "export const cmd = 'x'\n")
    await write('shared/linked/package.json', JSON.stringify({ name: 'linked', main: 'index.mjs' }))
    await mkdir(path.join(root, 'node_modules'), { recursive: true })
    await symlink(path.join(root, 'shared/linked'), path.join(root, 'node_modules/linked'))
    for (const spec of [await realpath(preset), 'linked']) {
      const cfg = await write(
        'packages/q2/vx.config.mjs',
        `import { cmd } from '${spec}'\nexport default { tasks: { t: { exec: { command: cmd } } } }\n`,
      )
      expect({ spec, key: await keyOf(cfg) }).toEqual({ spec, key: null })
    }
    // Control: the same file imported relatively is keyed.
    const rel = await write(
      'packages/q3/vx.config.mjs',
      "import { cmd } from '../../shared/linked/index.mjs'\nexport default { tasks: { t: { exec: { command: cmd } } } }\n",
    )
    expect(await keyOf(rel)).not.toBeNull()
  })

  it('a file two imports reach is in the closure once (item 653)', async () => {
    const c = await write('shared/d/c.mjs', "export const c = 'c'\n")
    const a = await write('shared/d/a.mjs', "import { c } from './c.mjs'\nexport const a = c\n")
    const b = await write('shared/d/b.mjs', "import { c } from './c.mjs'\nexport const b = c\n")
    const cfg = await write(
      'packages/dia/vx.config.mjs',
      "import { a } from '../../shared/d/a.mjs'\nimport { b } from '../../shared/d/b.mjs'\nexport default { tasks: { t: { exec: { command: a + b } } } }\n",
    )
    expect((await keyedOf(cfg))?.closure).toEqual([
      cfg,
      await realpath(a),
      await realpath(b),
      await realpath(c),
    ])
  })

  it('refuses a RELATIVE import that lands in node_modules (item 653)', async () => {
    // Installed bytes are the lockfile's to vouch for, not the closure's:
    // relative spelling does not make a package file part of the config.
    await write('node_modules/nm-preset/x.mjs', "export const cmd = 'x'\n")
    const cfg = await write(
      'packages/nm/vx.config.mjs',
      "import { cmd } from '../../node_modules/nm-preset/x.mjs'\nexport default { tasks: { t: { exec: { command: cmd } } } }\n",
    )
    expect(await keyOf(cfg)).toBeNull()
  })

  it('a closure past 32 files evaluates live; one at 32 is keyed (item 653)', async () => {
    // A chain: the config imports c1, c1 imports c2, … The config counts.
    const chain = async (dir: string, files: number) => {
      for (let i = 1; i <= files; i++) {
        const next = i < files ? `import './c${i + 1}.mjs'\n` : ''
        await write(`${dir}/c${i}.mjs`, `${next}export const v = ${i}\n`)
      }
      return write(`${dir}/vx.config.mjs`, "import './c1.mjs'\nexport default { tasks: {} }\n")
    }
    expect(await keyOf(await chain('packages/at-cap', 31))).not.toBeNull()
    expect(await keyOf(await chain('packages/past-cap', 32))).toBeNull()
  })

  it.skipIf(skipAsRoot('an import that resolves but cannot be read is not keyed'))(
    'an import that resolves but cannot be read is not keyed (item 653)',
    async () => {
      // "Null when its closure cannot be read": the live evaluation then
      // reports the file on its own terms, not a raw EACCES from keying.
      const locked = await write('shared/locked.mjs', "export const cmd = 'x'\n")
      await chmod(locked, 0o000)
      const cfg = await write(
        'packages/lk/vx.config.mjs',
        "import { cmd } from '../../shared/locked.mjs'\nexport default { tasks: { t: { exec: { command: cmd } } } }\n",
      )
      expect(await keyOf(cfg)).toBeNull()
    },
  )

  it('the warm key from the closure IS the slow key — the two paths share entries (item 653)', async () => {
    // Were they to differ, every warm fast key would miss and the slow
    // key's own lookup would still serve the config: correct, and every
    // warm load paying the read and scan the index exists to skip.
    const preset = await write('shared/same.mjs', "export const cmd = 'x'\n")
    const cfg = await write(
      'packages/same/vx.config.mjs',
      "import { cmd } from '../../shared/same.mjs'\nexport default { tasks: { t: { exec: { command: cmd } } } }\n",
    )
    const slow = await keyedOf(cfg)
    expect(slow?.closure).toEqual([cfg, await realpath(preset)])
    const fast = await configEvalKeyFromClosure({
      closure: slow!.closure,
      hashFile: async (f) => blobOidOf(await Bun.file(f).bytes()),
      workspaceFingerprint: 'fp',
    })
    expect(fast).toBe(slow!.key)
  })

  it('the key is seeded by the eval version, vx, Bun and the fingerprint, in that order (item 653)', async () => {
    // A stored evaluation is served WITHOUT re-validation, so it must not
    // outlive the vx or the Bun that validated it. Neither can change inside
    // one process, so the seed is pinned by re-deriving the key here from
    // the sources of truth (package.json, the runtime), not by varying them.
    const cfg = await write('packages/seed/vx.config.mjs', 'export default { tasks: {} }\n')
    const bytes = await Bun.file(cfg).bytes()
    const vxVersion = (
      JSON.parse(readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
        version: string
      }
    ).version
    const seed = xxh3(`vx-config-eval-v${CONFIG_EVAL_VERSION}\0${vxVersion}\0${Bun.version}\0fp\0`)
    const expected = xxh3(`${cfg}\0${blobOidOf(bytes)}`, seed)
      .toString(16)
      .padStart(16, '0')
    expect(await keyOf(cfg, 'fp')).toBe(expected)
    expect(await keyOf(cfg, 'fp2')).not.toBe(expected)
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
    // `Function` reached through a PROPERTY name (the deny-list matched the
    // identifier only), with the impure code inside a literal it strips;
    // and the one string method whose answer depends on the host locale.
    "({}).constructor.constructor('return process.env.HOME')()",
    "['b', 'a'].sort((x, y) => x.localeCompare(y))[0]",
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
  it('an escaped quote does not end a string (item 653)', () => {
    // Without the escape skip the string ends at `\'`, the rest of the line
    // reads as an open string and the whole config is refused: never a
    // wrong key, but a pure config that never caches.
    expect(stripLiterals('const s = \'it\\\'s\'\nconst t = "say \\"hi\\""\n')).toBe(
      'const s =  \nconst t =  \n',
    )
  })
  it('bails on a line break inside a quoted string (item 653)', () => {
    // A quote the lexer misread would otherwise swallow the following lines
    // as string text — here `process` — and call the file pure.
    // Two quotes, so no string is left open at the end: only the line-break
    // bail refuses it (a four-quote shape ends unterminated and the EOF bail
    // answers first).
    expect(stripLiterals("const a = 'x\nprocess.env.HOME\nconst b = 1'\n")).toBeNull()
  })
  it("an object literal's brace inside a template expression does not close it (item 653)", () => {
    // Were `{a: 1}`'s `}` taken as the expression's end, `process` after it
    // would be read as template text and stripped: a false "pure".
    expect(stripLiterals('const s = `${ {a: 1}.a + process.env.X }`\n')).toBe(
      'const s =   {a: 1}.a + process.env.X  \n',
    )
  })
  it('a second ${} in one template is code too (item 653)', () => {
    const out = stripLiterals('const s = `${a}-${process.env.X}`\n')
    expect(out).toContain('process.env.X')
    expect(out).not.toContain('-')
  })
  it('the expression closes after a nested object literal, and the file reads on (item 653)', () => {
    // With the object's `}` never counted back down, the expression never
    // ends and the template's closing backtick opens a new one to EOF: the
    // file is refused. Conservative, but a pure config that never caches.
    expect(stripLiterals('const s = `${ {a: 1}.a }`\nconst t = 1\n')).toBe(
      'const s =   {a: 1}.a  \nconst t = 1\n',
    )
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

describe('the purity deny-list is the whole list', () => {
  // The module states the stakes: the check fails SAFE, never fast — "a
  // false negative costs one evaluation, a false positive would cost a
  // STALE KEY, so the deny-list is deliberately wide". A member that drops
  // off the list is exactly that false positive: a config observing the
  // environment through it gets its evaluation cached and replayed.
  //
  // Asserted as the whole list rather than one row per global (a per-member
  // row leaves every other member unheld), with one MINIMAL snippet each —
  // verified one-to-one, so no snippet is refused on another member's
  // account.
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['process', 'const v = process.env.FOO'],
    ['Bun', 'const v = Bun.env.FOO'],
    ['globalThis', 'const v = globalThis.x'],
    ['global', 'const v = global.x'],
    ['self', 'const v = self.x'],
    ['fetch', 'const v = fetch'],
    ['Date', 'const v = Date.now()'],
    ['Temporal', 'const v = Temporal.Now'],
    ['Intl', 'const v = new Intl.NumberFormat()'],
    ['crypto', 'const v = crypto.randomUUID()'],
    ['performance', 'const v = performance.now()'],
    ['navigator', 'const v = navigator.userAgent'],
    ['require', 'const v = require'],
    ['eval', "const v = eval('1')"],
    ['Function', "const v = new Function('return 1')"],
    ['constructor', 'const v = ({}).constructor'],
    ['localeCompare', "const v = 'a'.localeCompare('b')"],
    ['await', 'const v = await Promise.resolve(1)'],
    ['toLocaleUpperCase', "const v = 'x'.toLocaleUpperCase()"],
    ['import.meta', 'const v = import.meta.dir'],
    ['Math.random', 'const v = Math.random()'],
    ['dynamic import', "const v = import('./x.js')"],
  ]

  it('refuses a config for every global on it, and caches one that touches none', async () => {
    let i = 0
    for (const [label, body] of CASES) {
      const file = await write(
        `packages/deny-${String(i++)}/vx.config.mjs`,
        `${body}\nexport default { name: 'p' }\n`,
      )
      expect([label, await keyOf(file)]).toEqual([label, null])
    }
    // CONTROL: the refusals above are the LIST's doing, not a config shape
    // this function rejects wholesale.
    const pure = await write('packages/deny-pure/vx.config.mjs', "export default { name: 'p' }\n")
    expect(await keyOf(pure)).not.toBeNull()
  })

  it('refuses a config the literal stripper cannot read, rather than trusting it', async () => {
    // `stripLiterals` answers null for source it cannot scan safely — a
    // regex literal (a bare `/` it will not try to parse), an unterminated
    // string. The deny-list never sees that source, so the null is the only
    // thing standing between it and a cached evaluation.
    const withRegex = await write(
      'packages/strip-regex/vx.config.mjs',
      "export default { name: 'ab'.replace(/a/, 'b') }\n",
    )
    expect(await keyOf(withRegex)).toBeNull()
    const unterminated = await write(
      'packages/strip-open/vx.config.mjs',
      "const s = 'oops\nexport default { name: 'p' }\n",
    )
    expect(await keyOf(unterminated)).toBeNull()
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

  it('a round writes what it learned once per table, and keys the slow path from bytes, not the memo', async () => {
    const preset = await write('shared/batch-preset.mjs', "export const cmd = 'echo b'\n")
    const cfgs: string[] = []
    for (const name of ['b1', 'b2', 'b3']) {
      cfgs.push(
        await write(
          `packages/${name}/vx.config.mjs`,
          "import { cmd } from '../../shared/batch-preset.mjs'\nexport default { tasks: { build: { exec: { command: cmd } } } }\n",
        ),
      )
    }
    const store = new BatchedStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    await loadProjectConfigs(cfgs, { evalCache })
    // Three evaluations, three closures: one batched call each (a per-config
    // put was an autocommit transaction each; item 615).
    expect({
      evalPuts: store.batchEvalPuts,
      closurePuts: store.batchClosurePuts,
      entries: store.puts,
      closures: store.closures.size,
    }).toEqual({ evalPuts: 1, closurePuts: 1, entries: 3, closures: 3 })
    // The slow path keyed every closure file from the bytes it read to
    // scan it: no stat-memo call, so no memo row per file.
    expect({ bytesHashes: store.bytesHashes, memoHashes: store.hashes }).toEqual({
      bytesHashes: 6, // three configs and the preset each of them imports
      memoHashes: 0,
    })
    // The fast path next time is the memo's (hashFile per closure file),
    // and the batch wrote nothing more: nothing evaluated, nothing put.
    await loadProjectConfigs(cfgs, { evalCache })
    expect({
      evalPuts: store.batchEvalPuts,
      entries: store.puts,
      hashed: store.hashes > 0,
    }).toEqual({ evalPuts: 1, entries: 3, hashed: true })
    // A store without the batched methods is given the entries one by one.
    const plain = new MemoryStore()
    await loadProjectConfigs(cfgs, { evalCache: { store: plain, workspaceFingerprint: 'fp' } })
    expect({ puts: plain.puts, closures: plain.closures.size }).toEqual({ puts: 3, closures: 3 })
    // A failed round still keeps what it learned before the failure.
    const bad = await write('packages/b-bad/vx.config.mjs', 'export default { tasks: 42 }\n')
    const partial = new BatchedStore()
    await expect(
      loadProjectConfigs([cfgs[0]!, bad], {
        evalCache: { store: partial, workspaceFingerprint: 'fp' },
      }),
    ).rejects.toThrow(/b-bad/)
    expect({ evalPuts: partial.batchEvalPuts, entries: partial.puts }).toEqual({
      evalPuts: 1,
      entries: 1,
    })
    void preset
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
    noRead.putConfigClosure('/p/vx.config.mjs', ['/p/vx.config.mjs'])
    // The write landed; neither read serves it — the batched one is the one
    // a run's config load uses.
    expect(noRead.getConfigEval('k')).toBeNull()
    expect(noRead.getConfigEvals(['k']).size).toBe(0)
    expect(noRead.getConfigClosures(['/p/vx.config.mjs']).size).toBe(0)
    noRead.close()
    const readBack = new Cache(path.join(root, 'nr'))
    expect(readBack.getConfigEvals(['k']).get('k')).toBe('{}')
    readBack.close()
  })
  it('the batched puts honour the write axis and land as the single puts do', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-cc-batch-'))
    try {
      const wo = new Cache(dir, { read: true, write: false })
      wo.putConfigEvals([['k1', '{}']])
      wo.putConfigClosures([['/p/vx.config.mjs', ['/p/vx.config.mjs']]])
      expect({
        evals: wo.getConfigEvals(['k1']).size,
        closures: wo.getConfigClosures(['/p/vx.config.mjs']).size,
      }).toEqual({ evals: 0, closures: 0 })
      wo.close()
      const rw = new Cache(dir)
      rw.putConfigEvals([
        ['k1', '{"tasks":{}}'],
        ['k2', '{"tasks":{"a":{}}}'],
      ])
      rw.putConfigClosures([
        ['/p/vx.config.mjs', ['/p/vx.config.mjs', '/p/preset.mjs']],
        ['/q/vx.config.mjs', ['/q/vx.config.mjs']],
      ])
      expect(
        [...rw.getConfigEvals(['k1', 'k2']).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      ).toEqual([
        ['k1', '{"tasks":{}}'],
        ['k2', '{"tasks":{"a":{}}}'],
      ])
      expect(
        rw.getConfigClosures(['/p/vx.config.mjs', '/q/vx.config.mjs']).get('/p/vx.config.mjs'),
      ).toEqual(['/p/vx.config.mjs', '/p/preset.mjs'])
      expect(rw.getConfigEval('k2')).toBe('{"tasks":{"a":{}}}') // the single read sees the batched write
      rw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a re-learned closure replaces the old one and restarts its retention clock', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-cc-reclose-'))
    try {
      const first = new Cache(dir)
      first.putConfigClosure('/p/vx.config.mjs', ['/p/vx.config.mjs'])
      first.close()
      // Age the row past retention, as a config indexed long ago would be.
      const db = new Database(path.join(dir, 'cache.db'))
      db.run('UPDATE config_closures SET created_at = 0')
      db.close()
      const again = new Cache(dir)
      again.putConfigClosures([['/p/vx.config.mjs', ['/p/vx.config.mjs', '/p/preset.mjs']]])
      again.close() // retention prunes on close
      const reopened = new Cache(dir)
      expect(reopened.getConfigClosures(['/p/vx.config.mjs']).get('/p/vx.config.mjs')).toEqual([
        '/p/vx.config.mjs',
        '/p/preset.mjs',
      ])
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('the batched reads answer every key across the 900-parameter chunks', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-cc-chunks-'))
    try {
      const cache = new Cache(dir)
      const keys = Array.from({ length: 1801 }, (_, i) => `k${i}`)
      const configs = keys.map((k) => `/w/${k}/vx.config.mjs`)
      cache.putConfigEvals(keys.map((k) => [k, `"${k}"`] as const))
      cache.putConfigClosures(configs.map((c) => [c, [c]] as const))
      expect(cache.getConfigEvals(keys).size).toBe(1801)
      expect(cache.getConfigClosures(configs).size).toBe(1801)
      cache.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

// Loader paths the item-653 sweep found unheld: each is a COST claim (one
// batched call, one lookup per round), invisible to a row that checks only
// which config came back, because a slower path answers the same.
describe('the eval-cache loader keeps its round to one call per question (item 653)', () => {
  /** A store whose single-key lookups and per-file identities are counted. */
  class CountingStore extends MemoryStore {
    singleGets = 0
    batchIdentities = 0
    /** Paths `hashFiles` answers nothing for, as if their stat failed. */
    unstatable = new Set<string>()
    override getConfigEval(key: string): string | null {
      this.singleGets++
      return super.getConfigEval(key)
    }
    async hashFiles(files: readonly string[]): Promise<Map<string, string>> {
      this.batchIdentities++
      const out = new Map<string, string>()
      for (const f of files) {
        if (!this.unstatable.has(f)) out.set(f, blobOidOf(await Bun.file(f).bytes()))
      }
      return out
    }
  }

  async function indexed(name: string) {
    const cfg = await write(
      `packages/${name}/vx.config.mjs`,
      "export default { tasks: { build: { exec: { command: 'live' } } } }\n",
    )
    const store = new CountingStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    await loadProjectConfigs([cfg], { evalCache })
    expect(store.closures.get(cfg)).toEqual([cfg])
    const [key] = [...store.rows.keys()]
    store.rows.set(key!, JSON.stringify({ tasks: { build: { exec: { command: 'stored' } } } }))
    store.hashes = 0
    return { cfg, store, evalCache }
  }

  it('a warm load identifies the indexed closure in ONE hashFiles call, never per file', async () => {
    const { cfg, store, evalCache } = await indexed('w1')
    const [c] = await loadProjectConfigs([cfg], { evalCache })
    expect(c?.tasks?.build?.exec?.command).toBe('stored')
    expect({
      batch: store.batchIdentities,
      perFile: store.hashes,
      single: store.singleGets,
    }).toEqual({ batch: 1, perFile: 0, single: 0 })
  })

  it('a fast key that cannot be built joins the round lookup on its slow key', async () => {
    // The batch answers nothing for the config (a failed stat): no fast key.
    // The slow key is then computed up front and asked in the ONE batched
    // lookup — not re-derived later and asked one key at a time.
    const { cfg, store, evalCache } = await indexed('w2')
    store.unstatable.add(cfg)
    const batchGets = store.batchGets
    const [c] = await loadProjectConfigs([cfg], { evalCache })
    expect(c?.tasks?.build?.exec?.command).toBe('stored')
    expect({ batchGets: store.batchGets - batchGets, single: store.singleGets }).toEqual({
      batchGets: 1,
      single: 0,
    })
  })

  it('a config edited BACK is served by its slow key, and the index follows it back', async () => {
    // A imports p1 (stored, indexed), then p2 (stored, re-indexed), then p1
    // again: the index still names p2, so the fast key misses — but the slow
    // key is the first round's, and that evaluation is served, not redone.
    const p1 = await realpath(await write('shared/p1.mjs', "export const cmd = 'one'\n"))
    const p2 = await realpath(await write('shared/p2.mjs', "export const cmd = 'two'\n"))
    const via = (p: string) =>
      `import { cmd } from '../../shared/${p}.mjs'\nexport default { tasks: { build: { exec: { command: cmd } } } }\n`
    const cfg = await write('packages/w4/vx.config.mjs', via('p1'))
    const store = new CountingStore()
    const evalCache = { store, workspaceFingerprint: 'fp' }
    await loadProjectConfigs([cfg], { evalCache })
    const [keyOne] = [...store.rows.keys()]
    store.rows.set(keyOne!, JSON.stringify({ tasks: { build: { exec: { command: 'stored' } } } }))
    await writeFile(cfg, via('p2'))
    await loadProjectConfigs([cfg], { evalCache })
    expect(store.closures.get(cfg)).toEqual([cfg, p2])
    const puts = store.puts
    await writeFile(cfg, via('p1'))
    const [c] = await loadProjectConfigs([cfg], { evalCache })
    expect(c?.tasks?.build?.exec?.command).toBe('stored')
    expect(store.puts).toBe(puts) // nothing evaluated
    expect(store.closures.get(cfg)).toEqual([cfg, p1]) // re-indexed on the slow hit
  })

  it('a round with no cacheable config asks the store nothing', async () => {
    // Every config impure: no key, so no lookup — not an empty `IN ()` query.
    const cfg = await write(
      'packages/w5/vx.config.mjs',
      'export default { tasks: { build: { exec: { command: String(process.pid) } } } }\n',
    )
    const store = new CountingStore()
    await loadProjectConfigs([cfg], { evalCache: { store, workspaceFingerprint: 'fp' } })
    expect({ batchGets: store.batchGets, single: store.singleGets, puts: store.puts }).toEqual({
      batchGets: 0,
      single: 0,
      puts: 0,
    })
  })

  it('a store with no closure index is served from the round lookup', async () => {
    // Only `hits` can serve here: with no index there is no fast key, so no
    // indexed slow path re-asking the store one key at a time.
    const cfg = await write(
      'packages/w3/vx.config.mjs',
      "export default { tasks: { build: { exec: { command: 'live' } } } }\n",
    )
    const rows = new Map<string, string>()
    const store: ConfigEvalStore = {
      getConfigEval: (k) => rows.get(k) ?? null,
      putConfigEval: (k, json) => void rows.set(k, json),
    }
    const evalCache = { store, workspaceFingerprint: 'fp' }
    await loadProjectConfigs([cfg], { evalCache })
    expect(rows.size).toBe(1)
    const [key] = [...rows.keys()]
    rows.set(key!, JSON.stringify({ tasks: { build: { exec: { command: 'stored' } } } }))
    const [c] = await loadProjectConfigs([cfg], { evalCache })
    expect(c?.tasks?.build?.exec?.command).toBe('stored')
  })
})
