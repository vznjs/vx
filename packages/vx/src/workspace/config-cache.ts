// Config evaluation cache — skip re-evaluating a `vx.config` that cannot
// have changed.
//
// A config is a program, and evaluating a thousand of them is the largest
// fixed cost of a warm run (measured 2026-09-02: ~80 ms to import 1000
// synthetic configs, ~12 ms to read the same files as data). The cache
// stores the VALIDATED, JSON-serialised result keyed by everything the
// evaluation could have observed:
//
//   - the config's bytes and the bytes of every file it transitively imports
//     by RELATIVE specifier (the closure), paths included;
//   - the workspace fingerprint (lockfiles), which covers package imports;
//   - Bun's version, vx's version and this module's own version. A stored
//     evaluation is served WITHOUT re-validation, so it must never outlive
//     the validator that accepted it — a vx upgrade that tightens a rule
//     re-evaluates every config once.
//
// It applies only to configs that are PROVABLY pure by a conservative static
// check: every import is relative or `@vzn/vx` (whose `defineProject` /
// `defineWorkspace` are identity functions), and no file in the closure
// mentions a global through which the environment can leak — `process`,
// `Bun`, `Date`, `fetch`, `import.meta`, `require`, a dynamic `import()`,
// `await`, … Anything else evaluates live, exactly as before. The check
// fails SAFE, never fast: a false negative costs one evaluation, a false
// positive would cost a stale key, so the deny-list is deliberately wide.
//
// JSON is already the contract for a config object — `hashTaskConfig` and
// `vx lock` both go through `JSON.stringify` — so a cached config derives
// the same cache key as a live evaluation of the same bytes.

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { xxh3 } from '../util/index.js'
import { VERSION } from '../version.js'

/** Bump when the key derivation or the stored shape changes. */
export const CONFIG_EVAL_VERSION = 2

/** Where cached evaluations live; `Cache` implements it over `cache.db`. */
export interface ConfigEvalStore {
  /**
   * The warm fast path (all optional; a store without them keys by bytes).
   * `hashFile` is the file's git blob id behind an mtime/size/ctime/inode
   * memo — no read when unchanged; `getConfigClosures` / `putConfigClosure`
   * keep each config's ORDERED closure (the config first, then every
   * relative import in discovery order), so a warm load keys the config by
   * stat-hashing that list instead of reading and scanning every file
   * (1,000 configs: 5 ms against 15, measured 2026-09-03). Sound because
   * closure membership can only change by editing a listed file, which
   * changes that file's hash and so the key; the one exception, an
   * extensionless relative import whose resolution a new file could
   * shadow, is never indexed.
   */
  hashFile?(file: string): Promise<string>
  getConfigClosures?(configPaths: readonly string[]): Map<string, string[]>
  putConfigClosure?(configPath: string, files: readonly string[]): void
  getConfigEval(key: string): string | null
  /**
   * Many keys in one round-trip (optional; a store without it is asked per
   * key). A warm 1000-project run paid 3.6 ms for 1,000 point lookups where
   * one `IN` query costs 0.7 (measured 2026-09-03).
   */
  getConfigEvals?(keys: readonly string[]): Map<string, string>
  putConfigEval(key: string, json: string): void
}

/** What `configEvalKey` learned besides the key, for the store's closure index. */
export interface ConfigEvalKeyResult {
  key: string
  /** The config first, then every relative import in discovery order. */
  closure: string[]
  /** False when a relative import is extensionless — a new file could change its resolution. */
  indexable: boolean
}

export interface ConfigEvalKeyArgs {
  configPath: string
  /**
   * Per-file identity, the same function the store's warm path uses. Absent
   * (tests, a store without one), the git blob id is computed from the
   * bytes in-process.
   */
  hashFile?: (file: string) => Promise<string>
  bytes: Uint8Array
  workspaceFingerprint: string
}

/** Closure files beyond this count evaluate live — a preset tree this deep is not the case this serves. */
const MAX_CLOSURE_FILES = 32

// Globals through which an evaluation can observe something the file bytes
// do not capture. Tested against the source with string literals and
// comments removed (`stripLiterals`), because `node -e "process.exit(0)"`
// is an ordinary command, not an impure config.
// `global` and `self` are live objects in Bun (aliases of `globalThis`), so
// a computed `global['proc' + 'ess']` reaches process without ever
// spelling it; `Temporal` is a clock. All three were CACHED AS PURE before
// they were listed (2026-09-03).
const IMPURE_RE =
  /\b(?:process|Bun|globalThis|global|self|fetch|Date|Temporal|Intl|crypto|performance|navigator|require|eval|Function|await|toLocale\w*)\b|import\s*\.\s*meta|Math\s*\.\s*random|\bimport\s*\(/

// Static `import … from '…'` / `export … from '…'` / `import '…'` forms.
// `[^;'"]*?` spans newlines, so multi-line specifier lists match.
const IMPORT_RE =
  /(?:^|[\n;])\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g

/** The one bare specifier a pure config may import: core's identity helpers and types. */
const PURE_PACKAGE = '@vzn/vx'

const decoder = new TextDecoder()

/**
 * `source` with every string literal, template literal and comment removed
 * (template `${…}` expressions are kept — they are code). Returns `null`
 * when a `/` in code position is neither a comment nor a division the
 * lexer can prove: a regex literal can contain a quote, and a lexer that
 * misreads one would swallow real code as a string — a false SAFE, the one
 * outcome this module must never produce. Configs do not need regexes;
 * such a config evaluates live.
 */
export function stripLiterals(source: string): string | null {
  let out = ''
  let i = 0
  const n = source.length
  // Brace depth per open template expression, so a `}` closing the
  // expression is told apart from one closing an object literal inside it.
  const templateDepth: number[] = []
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 2
      continue
    }
    if (c === '/') return null
    if (c === "'" || c === '"') {
      i++
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') i++
        if (source[i] === '\n') return null
        i++
      }
      if (i >= n) return null
      i++
      out += ' '
      continue
    }
    if (c === '`') {
      i++
      for (;;) {
        if (i >= n) return null
        const t = source[i]!
        if (t === '\\') {
          i += 2
          continue
        }
        if (t === '`') {
          i++
          break
        }
        if (t === '$' && source[i + 1] === '{') {
          templateDepth.push(0)
          i += 2
          out += ' '
          break
        }
        i++
      }
      continue
    }
    if (templateDepth.length > 0) {
      const top = templateDepth.length - 1
      if (c === '{') templateDepth[top]!++
      else if (c === '}') {
        if (templateDepth[top] === 0) {
          // Back into the template literal: resume scanning its text.
          templateDepth.pop()
          i++
          for (;;) {
            if (i >= n) return null
            const t = source[i]!
            if (t === '\\') {
              i += 2
              continue
            }
            if (t === '`') {
              i++
              break
            }
            if (t === '$' && source[i + 1] === '{') {
              templateDepth.push(0)
              i += 2
              break
            }
            i++
          }
          out += ' '
          continue
        }
        templateDepth[top]!--
      }
    }
    out += c
    i++
  }
  return out
}

/**
 * The cache key for evaluating `configPath`, or `null` when the config is
 * not provably pure (or its closure cannot be read), in which case the
 * caller evaluates live and stores nothing.
 */
/** `git hash-object` of `bytes` (sha1 domain), the identity `Cache.hashFile` returns for a sha1 repo. */
export function blobOidOf(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha1')
  hasher.update(`blob ${bytes.byteLength}\0`)
  hasher.update(bytes)
  return hasher.digest('hex')
}

function keySeed(workspaceFingerprint: string): bigint {
  return xxh3(
    `vx-config-eval-v${CONFIG_EVAL_VERSION}\0${VERSION}\0${Bun.version}\0${workspaceFingerprint}\0`,
  )
}

const EXPLICIT_EXT = /\.(?:m?[jt]s|cjs|cts)$/

export async function configEvalKey(a: ConfigEvalKeyArgs): Promise<ConfigEvalKeyResult | null> {
  let h = keySeed(a.workspaceFingerprint)
  const hashOf = a.hashFile ?? (async (_file: string, bytes?: Uint8Array) => blobOidOf(bytes!))
  const visited = new Set<string>([a.configPath])
  const closure: string[] = []
  let indexable = true
  const queue: Array<{ file: string; bytes: Uint8Array }> = [{ file: a.configPath, bytes: a.bytes }]
  while (queue.length > 0) {
    const { file, bytes } = queue.shift()!
    const source = decoder.decode(bytes)
    const code = stripLiterals(source)
    // A backslash in code position is an identifier escape (`\u0070rocess`
    // IS `process`) — the one spelling the deny-list cannot see. Refuse it.
    if (code === null || code.includes('\\') || IMPURE_RE.test(code)) return null
    const identity = a.hashFile ? await a.hashFile(file) : await hashOf(file, bytes)
    h = xxh3(`${file}\0${identity}`, h)
    closure.push(file)
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2]!
      if (spec === PURE_PACKAGE) continue
      if (!spec.startsWith('./') && !spec.startsWith('../')) return null
      if (!EXPLICIT_EXT.test(spec)) indexable = false
      let resolved: string
      try {
        // Real-pathed: `Bun.resolveSync` answers with the symlinked spelling
        // on one call and the real one on another (a tmp workspace under
        // /var vs /private/var), and the key folds the path — a spelling
        // that drifts between runs is a spurious miss and a duplicated
        // memo row.
        resolved = realpathSync(Bun.resolveSync(spec, path.dirname(file)))
      } catch {
        return null
      }
      if (visited.has(resolved)) continue
      if (resolved.split(path.sep).includes('node_modules')) return null
      visited.add(resolved)
      if (visited.size > MAX_CLOSURE_FILES) return null
      try {
        queue.push({ file: resolved, bytes: await Bun.file(resolved).bytes() })
      } catch {
        return null
      }
    }
  }
  return { key: h.toString(16).padStart(16, '0'), closure, indexable }
}

/**
 * The warm path: the key for a config whose ordered closure the store
 * remembers, from per-file identities alone — no read, no scan. The fold is
 * byte-identical to `configEvalKey`'s, so the two paths share entries. A
 * changed or vanished file changes its identity and misses, and the slow
 * path then re-indexes.
 */
export async function configEvalKeyFromClosure(a: {
  closure: readonly string[]
  hashFile: (file: string) => Promise<string>
  workspaceFingerprint: string
}): Promise<string | null> {
  let h = keySeed(a.workspaceFingerprint)
  let identities: string[]
  try {
    identities = await Promise.all(a.closure.map((f) => a.hashFile(f)))
  } catch {
    return null
  }
  for (let i = 0; i < a.closure.length; i++) h = xxh3(`${a.closure[i]}\0${identities[i]}`, h)
  return h.toString(16).padStart(16, '0')
}
