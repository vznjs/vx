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

import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { xxh3 } from '../util/index.js'
import { VERSION } from '../version.js'

/** Bump when the key derivation or the stored shape changes. */
export const CONFIG_EVAL_VERSION = 3

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
  /**
   * `hashFile` over many paths with one memo query; a path that cannot be
   * stat'ed is absent. The warm load identifies every indexed closure's
   * files through this in a single call when the store offers it.
   */
  hashFiles?(files: readonly string[]): Promise<Map<string, string>>
  /**
   * The identity `hashFile` would return for a file holding `bytes`, from
   * the bytes alone — no stat, no memo row. The slow path has every
   * closure file's bytes in hand (it reads them to scan for imports), and
   * keying through `hashFile` there cost a memo upsert per file, each its
   * own autocommit transaction (1,000 configs: 50 ms, item 615). The first
   * warm load after it reads those files once for the memo, in one
   * transaction. `nearPath` says which repo's object format applies.
   */
  hashBytes?(bytes: Uint8Array, nearPath: string): string
  getConfigClosures?(configPaths: readonly string[]): Map<string, string[]>
  putConfigClosure?(configPath: string, files: readonly string[]): void
  /**
   * A round's closures in one write (optional; a store without it is
   * given them one by one). One transaction where the per-config put was
   * one each: 1,000 autocommit inserts measured 180–240 ms against 2.5 in
   * one transaction (item 615).
   */
  putConfigClosures?(entries: ReadonlyArray<readonly [string, readonly string[]]>): void
  getConfigEval(key: string): string | null
  /**
   * Many keys in one round-trip (optional; a store without it is asked per
   * key). A warm 1000-project run paid 3.6 ms for 1,000 point lookups where
   * one `IN` query costs 0.7 (measured 2026-09-03).
   */
  getConfigEvals?(keys: readonly string[]): Map<string, string>
  putConfigEval(key: string, json: string): void
  /** A round's evaluations in one write, as `putConfigClosures` (optional). */
  putConfigEvals?(entries: ReadonlyArray<readonly [string, string]>): void
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
  /** The identity of a file from its bytes; preferred over `hashFile`, which stats and memoises. */
  hashBytes?: (bytes: Uint8Array, nearPath: string) => string
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
// they were listed (2026-09-03). `constructor` reaches `Function` through a
// property name (`({}).constructor.constructor('return process')()`, the
// body hidden in a literal the strip removes) and `localeCompare` answers
// by the host locale; both listed 2026-09-09.
const IMPURE_RE =
  /\b(?:process|Bun|globalThis|global|self|fetch|Date|Temporal|Intl|crypto|performance|navigator|require|eval|Function|constructor|localeCompare|await|toLocale\w*)\b|import\s*\.\s*meta|Math\s*\.\s*random|\bimport\s*\(/

// Static `import … from '…'` / `export … from '…'` / `import '…'` forms,
// matched on `stripLiterals` output with its strings kept as placeholders
// (`\0<n>\0`): a comment is gone, so an import after `/* … */` on its line
// is seen, and a string-named binding (`import { 'a-b' as x }`) is a
// placeholder like any other. `[^;]*?` spans newlines, so multi-line
// specifier lists match.
const IMPORT_RE =
  /(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*\0(\d+)\0|(?:^|[\n;])\s*import\s*\0(\d+)\0/g

/**
 * Every static import in `source` as its specifier and statement, or `null`
 * when the source cannot be lexed or holds an `import` no form above
 * accounts for — a spelling this scan misses must fail closed: an unseen
 * import is neither keyed nor gated for purity (item 952).
 */
function staticImports(
  source: string,
): { code: string; imports: Array<{ spec: string; statement: string }> } | null {
  const strings: string[] = []
  const code = stripLiterals(source, strings)
  if (code === null) return null
  const imports: Array<{ spec: string; statement: string }> = []
  let seen = 0
  for (const m of code.matchAll(IMPORT_RE)) {
    imports.push({ spec: strings[Number(m[1] ?? m[2])]!, statement: m[0] })
    seen += m[0].match(/\bimport\b/g)?.length ?? 0
  }
  if (seen !== (code.match(/\bimport\b/g)?.length ?? 0)) return null
  return { code, imports }
}

/** The one bare specifier a pure config may import: core's identity helpers and types. */
const PURE_PACKAGE = '@vzn/vx'

/**
 * The `@vzn/vx` values a pure config may import. Core exports far more, and
 * some of it reads the machine: a config calling `machineParallelism()` was
 * replayed from the store on a box with another core count, and its tasks
 * kept the key the first box's answer gave them (item 888). Types are
 * always fine; a name outside this list, a namespace or default import, or
 * an `export *` of the package evaluates live.
 */
export const PURE_CORE_EXPORTS: ReadonlySet<string> = new Set([
  'defineProject',
  'defineWorkspace',
  'splitTaskId',
  'normalizeGlob',
  'isLiteralPattern',
  'PLUGIN_HOOKS',
  'TASK_STATUSES',
  'PERSISTENT_TASK_NAMES',
])

/** Whether an `import`/`export … from '@vzn/vx'` statement takes only pure values. */
function importsOnlyPure(statement: string): boolean {
  const clause = statement
    .replace(/^[\s;]*(?:import|export)\s+/, '')
    .replace(/\bfrom\s*\0\d+\0\s*$/, '')
  if (/^type\b/.test(clause)) return true
  if (clause.includes('*')) return false
  const braces = /\{([^}]*)\}/.exec(clause)
  // Anything outside the braces is a default import.
  if (
    clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim() !== ''
  )
    return false
  for (const part of (braces?.[1] ?? '').split(',')) {
    const spec = part.trim()
    if (spec === '' || /^type\s/.test(spec)) continue
    const name = spec.split(/\s+as\s+/)[0]!.trim()
    if (!PURE_CORE_EXPORTS.has(name)) return false
  }
  return true
}

const decoder = new TextDecoder()

/**
 * `source` with every string literal, template literal and comment removed
 * (template `${…}` expressions are kept — they are code). Returns `null`
 * when a `/` in code position is neither a comment nor a division the
 * lexer can prove: a regex literal can contain a quote, and a lexer that
 * misreads one would swallow real code as a string — a false SAFE, the one
 * outcome this module must never produce. Configs do not need regexes;
 * such a config evaluates live. Given `strings`, a quoted string becomes
 * the placeholder `\0<n>\0` and its text `strings[n]`.
 */
export function stripLiterals(source: string, strings?: string[]): string | null {
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
      const start = ++i
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') i++
        if (source[i] === '\n') return null
        i++
      }
      if (i >= n) return null
      if (strings === undefined) out += ' '
      else out += `\0${strings.push(source.slice(start, i)) - 1}\0`
      i++
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

/**
 * The canonical directory Bun resolves `file`'s imports from: its REAL
 * path's, so a config linked in from elsewhere imports its neighbours
 * there, not beside the link (item 950). The directory is real-pathed
 * rather than the file, whose realpath opens it: a config is opened once
 * per run (`read-once.unsafe.test.ts`).
 */
function realDirOf(file: string): string {
  if (lstatSync(file).isSymbolicLink()) return path.dirname(realpathSync(file))
  return realpathSync(path.dirname(file))
}

/** A regular file reached through no symlink: the path IS the file. */
function isCanonicalFile(file: string): boolean {
  try {
    return realpathSync(file) === file && statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The cache key for evaluating `configPath`, or `null` when the config is
 * not provably pure (or its closure cannot be read), in which case the
 * caller evaluates live and stores nothing.
 */
export async function configEvalKey(a: ConfigEvalKeyArgs): Promise<ConfigEvalKeyResult | null> {
  let h = keySeed(a.workspaceFingerprint)
  const hashOf = a.hashFile ?? (async (_file: string, bytes?: Uint8Array) => blobOidOf(bytes!))
  const visited = new Set<string>([a.configPath])
  const closure: string[] = []
  let indexable = true
  const queue: Array<{ file: string; bytes: Uint8Array }> = [{ file: a.configPath, bytes: a.bytes }]
  while (queue.length > 0) {
    const { file, bytes } = queue.shift()!
    // Asked of the first relative import only: a config with none costs no
    // syscall for it.
    let dir: string | undefined
    const scanned = staticImports(decoder.decode(bytes))
    if (scanned === null) return null
    const { code } = scanned
    // A backslash in code position is an identifier escape (`\u0070rocess`
    // IS `process`) — the one spelling the deny-list cannot see. Refuse it.
    if (code.includes('\\') || IMPURE_RE.test(code)) return null
    const identity = a.hashBytes
      ? a.hashBytes(bytes, file)
      : a.hashFile
        ? await a.hashFile(file)
        : await hashOf(file, bytes)
    h = xxh3(`${file}\0${identity}`, h)
    closure.push(file)
    for (const { spec, statement } of scanned.imports) {
      if (spec === PURE_PACKAGE) {
        if (/\bfrom\s*\0\d+\0\s*$/.test(statement) && !importsOnlyPure(statement)) return null
        continue
      }
      if (!spec.startsWith('./') && !spec.startsWith('../')) return null
      // The warm path re-hashes the files this resolution found and never
      // resolves again, so it holds only when the specifier names its file
      // outright: an explicit extension, no symlink on the way. A link
      // retargeted without touching a listed file, or Bun's `.js` → `.ts`
      // fallback (a `preset.js` created beside `preset.ts` takes over),
      // moves the answer; such a closure is keyed but never indexed
      // (item 950). The named file is taken without `Bun.resolveSync`,
      // whose directory cache answers a retargeted link with its old
      // target for the rest of the process.
      try {
        dir ??= realDirOf(file)
      } catch {
        return null
      }
      const named = path.resolve(dir, spec)
      let resolved: string
      if (EXPLICIT_EXT.test(spec) && isCanonicalFile(named)) resolved = named
      else {
        indexable = false
        try {
          // Real-pathed: `Bun.resolveSync` answers with the symlinked
          // spelling on one call and the real one on another (a tmp
          // workspace under /var vs /private/var), and the key folds the
          // path — a spelling that drifts between runs is a spurious miss
          // and a duplicated memo row.
          resolved = realpathSync(Bun.resolveSync(spec, dir))
        } catch {
          return null
        }
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

/**
 * Every file a config imports by relative specifier, transitively, outside
 * `node_modules`, the config itself excluded. `vx watch` watches these: a
 * shared preset outside the project (`../../shared/preset.mjs`, the way
 * configs compose) changed what a run evaluates and no watcher saw it
 * (item 949). A file that cannot be read or resolved ends its branch.
 */
export async function configImports(configPath: string): Promise<string[]> {
  const seen = new Set<string>([configPath])
  const out: string[] = []
  const queue = [configPath]
  while (queue.length > 0) {
    const file = queue.shift()!
    let source: string
    try {
      source = await Bun.file(file).text()
    } catch {
      continue
    }
    let dir: string | undefined
    // A source the scan cannot read keeps the imports it can see: watching
    // too few files is what this list exists to prevent.
    const specs =
      staticImports(source)?.imports.map((i) => i.spec) ??
      [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)].map(
        (m) => (m[1] ?? m[2])!,
      )
    for (const spec of specs) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue
      let resolved: string
      try {
        dir ??= realDirOf(file)
        resolved = realpathSync(Bun.resolveSync(spec, dir))
      } catch {
        continue
      }
      if (seen.has(resolved) || resolved.split(path.sep).includes('node_modules')) continue
      seen.add(resolved)
      out.push(resolved)
      queue.push(resolved)
    }
  }
  return out
}
