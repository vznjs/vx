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

import path from 'node:path'
import { xxh3 } from '../util/index.js'
import { VERSION } from '../version.js'

/** Bump when the key derivation or the stored shape changes. */
export const CONFIG_EVAL_VERSION = 1

/** Where cached evaluations live; `Cache` implements it over `cache.db`. */
export interface ConfigEvalStore {
  getConfigEval(key: string): string | null
  putConfigEval(key: string, json: string): void
}

export interface ConfigEvalKeyArgs {
  configPath: string
  bytes: Uint8Array
  workspaceFingerprint: string
}

/** Closure files beyond this count evaluate live — a preset tree this deep is not the case this serves. */
const MAX_CLOSURE_FILES = 32

// Globals through which an evaluation can observe something the file bytes
// do not capture. Tested against the source with string literals and
// comments removed (`stripLiterals`), because `node -e "process.exit(0)"`
// is an ordinary command, not an impure config.
const IMPURE_RE =
  /\b(?:process|Bun|globalThis|fetch|Date|Intl|crypto|performance|navigator|require|eval|Function|await|toLocale\w*)\b|import\s*\.\s*meta|Math\s*\.\s*random|\bimport\s*\(/

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
export async function configEvalKey(a: ConfigEvalKeyArgs): Promise<string | null> {
  let h = xxh3(
    `vx-config-eval-v${CONFIG_EVAL_VERSION}\0${VERSION}\0${Bun.version}\0${a.workspaceFingerprint}\0`,
  )
  const visited = new Set<string>([a.configPath])
  const queue: Array<{ file: string; bytes: Uint8Array }> = [{ file: a.configPath, bytes: a.bytes }]
  while (queue.length > 0) {
    const { file, bytes } = queue.shift()!
    const source = decoder.decode(bytes)
    const code = stripLiterals(source)
    if (code === null || IMPURE_RE.test(code)) return null
    h = xxh3(`${file}\0`, h)
    h = xxh3(bytes, h)
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2]!
      if (spec === PURE_PACKAGE) continue
      if (!spec.startsWith('./') && !spec.startsWith('../')) return null
      let resolved: string
      try {
        resolved = Bun.resolveSync(spec, path.dirname(file))
      } catch {
        return null
      }
      if (visited.has(resolved)) continue
      // A relative path that lands in a dependency's tree is the lockfile's
      // business, and reading it here would key on bytes the fingerprint
      // already covers — but a package can also be a workspace symlink whose
      // source moves without the lockfile moving. Evaluate live instead.
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
  return h.toString(16).padStart(16, '0')
}
