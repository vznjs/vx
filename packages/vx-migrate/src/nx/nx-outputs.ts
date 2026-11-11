// An Nx target's `outputs` as vx's cache outputs: project globs and
// workspace-root globs. Extracted from `buildTask` in item 606.

import path from 'node:path'
import { isLiteralPattern } from '@vzn/vx'
import { gluedGlobstarAsStar, literalGlob, minimatchToVx, nxBareGroups } from '../glob-grammar.js'
import { takingBack } from '../shared-outputs.js'

interface NxOutputs {
  readonly outFiles: string[]
  readonly wsOutFiles: string[]
}

/**
 * Nx's `interpolate` for a path, as a workspace-relative one: `{workspaceRoot}`
 * is the root and `{projectRoot}` / `{projectName}` the project's, ANYWHERE
 * in the string — `{workspaceRoot}/coverage/{projectRoot}` is `@nx/jest`'s
 * output. Only a leading token was read before item 912, so that output
 * became the literal glob `coverage/{projectRoot}/**`, saved nothing, and a
 * hit restored nothing. Null when a token is left or the path leaves the
 * workspace; a brace set is no token (item 914 — 912 read one as a gap).
 * The project dir comes back masked: {@link withProjectDir} writes it in.
 */
export function nxWorkspacePath(s: string, projectRel: string, projectName: string): string | null {
  const rel = projectRel === '.' ? '' : projectRel
  const p = s
    .replaceAll('{workspaceRoot}', '')
    .replaceAll('{projectRoot}', masked(rel))
    .replaceAll('{projectName}', projectName)
  // A token left over is a gap; a brace set (`*.{ts,tsx}`) is a glob.
  if (/\{[\w.]+\}/.test(p)) return null
  const n = path.posix.normalize(p.replace(/^\/+/, '')).replace(/^\.\//, '')
  return n === '.' || n === '..' || n.startsWith('../') ? null : n
}

// A project dir is a path, never a glob: `packages/a{b}` read as a token
// dropped every `{projectRoot}` path, and `packages/[x]` translated as a
// class reached `packages/x`. Each dir segment stands in as `\uE000<i>\uE001`
// until the glob is vx's, so `..` still pops one.
const MASKED = /\uE000(\d+)\uE001/g

function masked(rel: string): string {
  return rel === ''
    ? ''
    : rel
        .split('/')
        .map((_, i) => `\uE000${i}\uE001`)
        .join('/')
}

/** `p` with the masked project dir written back: as a path, or escaped for a glob. */
export function withProjectDir(p: string, projectRel: string, asGlob: boolean): string {
  const segs = projectRel.split('/')
  return p.replace(MASKED, (_, i: string, at: number) => {
    const seg = segs[Number(i)]!
    if (!asGlob) return seg
    // Only a glob's head reads `!` as a negation.
    return at === 0 ? literalGlob(seg) : literalGlob(`/${seg}`).slice(1)
  })
}

/**
 * A workspace path relative to the project dir, or null when it lies
 * outside; `''` is the project dir itself, which Nx reads as the whole tree
 * (`path_or_everything_under`). As a workspace path, `{projectRoot}` cached
 * a literal core reads as another project's, and `{projectRoot}/` the empty
 * path, which saved and keyed nothing.
 */
export function underProject(p: string, projectRel: string): string | null {
  if (projectRel === '.' || projectRel === '') return p
  for (const dir of [masked(projectRel), projectRel]) {
    if (p === dir) return ''
    if (p.startsWith(`${dir}/`)) return p.slice(dir.length + 1).replace(/\/+$/, '')
  }
  return null
}

/**
 * What Nx caches for a target that declares no `outputs`
 * (`getOutputsForTargetAndConfiguration`): its `options.outputPath`, else,
 * for `build` and `prepare`, `dist/{root}`, `{root}/dist`, `{root}/build`
 * and `{root}/public`. Read as no outputs, a cached target's hit restored
 * nothing (item 1052). vx cleans an output before the task runs, and a
 * project's `build/` or `public/` is as often its committed sources, which
 * Nx, never cleaning, leaves alone: with `tops` (the project's tracked
 * top-level names) one git tracks nothing under is an output, and one it
 * does is left out with a todo; without `tops`, both are.
 */
export function nxDefaultOutputs(
  targetName: string,
  options: Record<string, unknown>,
  projectRel: string,
  todos: string[],
  tops?: ReadonlySet<string>,
): string[] {
  const outputPath = options['outputPath']
  if (typeof outputPath === 'string') return [outputPath]
  // A list is each of its paths, as Nx takes it; read as no `outputPath`,
  // the build cached the default directories and a hit restored none.
  if (Array.isArray(outputPath) && outputPath.length > 0) {
    if (outputPath.every((o) => typeof o === 'string')) return outputPath
  }
  if (targetName !== 'build' && targetName !== 'prepare') return []
  const root = projectRel === '.' ? '' : projectRel
  // As tokens, so the dir stays a path whatever its name holds.
  const at = (p: string): string => (root === '' ? p : `{projectRoot}/${p}`)
  const held = ['build', 'public'].filter((d) => tops === undefined || tops.has(d))
  if (held.length > 0)
    todos.push(
      `no outputs declared: Nx also caches ${held.map((d) => path.posix.join(root, d)).join(' and ')} for this target — vx cleans an output before the run, so add ${held.length === 1 ? 'it' : 'them'} to the outputs by hand only if ${held.length === 1 ? 'it holds' : 'they hold'} nothing committed`,
    )
  // The root project's two are one path.
  return [
    ...new Set([root === '' ? 'dist' : '{workspaceRoot}/dist/{projectRoot}', at('dist')]),
    ...['build', 'public'].filter((d) => !held.includes(d)).map(at),
  ]
}

/** `outputs` with `{options.x}` resolved against `options`; `projectRel` is the project dir, `.` for the root. */
export function mapNxOutputs(
  outputs: readonly string[],
  options: Record<string, unknown>,
  projectRel: string,
  projectName: string,
  todos: string[],
): NxOutputs {
  const outFiles: string[] = []
  const wsOutFiles: string[] = []
  for (const o of outputs) {
    // A `!` output takes a path back, as Nx's does (A-44); it maps as its
    // path does and keeps the `!`.
    const neg = o.startsWith('!') ? '!' : ''
    const r = withOptions(o.slice(neg.length), options)
    // Nx leaves an unset option's token in place and drops the output
    // (`getOutputsForTargetAndConfiguration`): @nx/eslint's
    // `{options.outputFile}` with no outputFile is no output, not a todo
    // on every lint target (2026-09-28).
    if (r === null) continue
    if (typeof r !== 'string') {
      todos.push(
        `output ${JSON.stringify(o)}: option ${JSON.stringify(r.notText)} is not a literal ` +
          'string — resolve manually',
      )
      continue
    }
    let s = r
    // `{workspaceRoot}` may come from a fallback, as Nx 24 reads it.
    const rootWide = (projectRel === '' || projectRel === '.') && s.startsWith('{workspaceRoot}')
    if (s.includes('{')) {
      // An options token Nx's grammar does not read (a literal before a
      // fallback) is no path either.
      const p = /\{options[.}]/.test(s) ? null : nxWorkspacePath(s, projectRel, projectName)
      if (p === null) {
        todos.push(`output ${JSON.stringify(o)} uses a token vx does not support`)
        continue
      }
      s = p
    }
    // Plain paths resolve against the workspace root in nx. One outside
    // the project dir is Nx's DEFAULT layout (`@nx/js:tsc` writes
    // `dist/<project>` at the root), so it is the workspace-root output it
    // is, not a gap: as a todo, every such target hit green and restored
    // NOTHING (item 593, the bench workspace's 1,000 `build` targets).
    // As written: core reads a literal as the path or the tree under it
    // (`asTrees`), and keeps a hit's directory short-circuit for either. The
    // `<rel>/**` this wrote for an extensionless name matched nothing under
    // a FILE, so a binary like `dist/bin/tool` was never saved (Next 27).
    // A path that leaves the workspace (an old generator's
    // `reportsDirectory: "../../coverage/<lib>"`, read from the workspace
    // root as Nx 23 reads it) has no place in a config: core refuses `..`,
    // so the written file failed to load and every task with it.
    const norm = path.posix.normalize(s.replace(/^\/+/, ''))
    if (norm === '..' || norm.startsWith('../')) {
      todos.push(
        `output ${JSON.stringify(o)} resolves to ${JSON.stringify(withProjectDir(norm, projectRel, false))}, outside the workspace — ` +
          'vx caches only inside it; dropped',
      )
      continue
    }
    const globs = vxOutputGlobs(neg + s)
    if (globs === null) {
      todos.push(`output ${JSON.stringify(o)} has a glob form vx cannot spell — dropped`)
      continue
    }
    for (const g of globs) {
      const gn = g.startsWith('!') ? '!' : ''
      const gs = g.slice(gn.length)
      // As the root project's inputs map (nx-inputs.ts): a `{workspaceRoot}`
      // output names a workspace path, which may lie in a nested project a
      // project glob never reaches (core refuses one there).
      const own = rootWide ? null : underProject(gs, projectRel)
      if (own !== null) {
        outFiles.push(gn + (own === '' ? '**' : withProjectDir(own, projectRel, true)))
        continue
      }
      const m = path.posix.normalize(gs).replace(/^\.\//, '')
      const w = withProjectDir(m, projectRel, true)
      wsOutFiles.push(gn + w)
      // An escaped brace makes a literal a glob, which core matches as the
      // path alone (`asTrees` adds the tree only to a literal).
      if (w !== withProjectDir(m, projectRel, false) && isLiteralPattern(m.replace(MASKED, '')))
        wsOutFiles.push(`${gn}${w}/**`)
    }
  }
  return { outFiles: takingBack(outFiles), wsOutFiles: takingBack(wsOutFiles) }
}

// Nx 24's tokens (`tasks-runner/tokens.js`): `{options.a.b}` walks the
// options, and `{options.x ?? {workspaceRoot}/dist/{projectRoot}}` falls
// back, braces nesting, to another option or a last literal. Read with a
// `[^}]+` key, the fallback was the key `outputPath ?? {workspaceRoot`: no
// value, so the output was dropped without a todo and a hit restored nothing.
type NxTokenPart =
  | { readonly kind: 'ref'; readonly name: string; readonly path?: string }
  | { readonly kind: 'literal'; readonly nodes: readonly NxTokenNode[] }
type NxTokenNode = string | readonly NxTokenPart[]

const OUTPUT_TOKENS = new Set(['projectRoot', 'projectName', 'project', 'options'])

function parseTokens(t: string): NxTokenNode[] {
  const nodes: NxTokenNode[] = []
  let text = ''
  let at = 0
  for (let open = t.indexOf('{'); open !== -1; open = t.indexOf('{', at)) {
    const close = closingBrace(t, open)
    const parts = close === -1 ? null : parseToken(t.slice(open + 1, close))
    // No token, but one may sit inside it: `{a,{projectRoot}}`.
    if (parts === null) {
      text += t.slice(at, open + 1)
      at = open + 1
      continue
    }
    text += t.slice(at, open)
    if (text !== '') nodes.push(text)
    text = ''
    nodes.push(parts)
    at = close + 1
  }
  text += t.slice(at)
  if (text !== '') nodes.push(text)
  return nodes
}

function parseToken(inner: string): NxTokenPart[] | null {
  const sources = splitFallbacks(inner)
  const parts: NxTokenPart[] = []
  for (const [i, src] of sources.entries()) {
    const dot = src.indexOf('.')
    const name = dot === -1 ? src : src.slice(0, dot)
    if (OUTPUT_TOKENS.has(name)) {
      parts.push(
        dot === -1 ? { kind: 'ref', name } : { kind: 'ref', name, path: src.slice(dot + 1) },
      )
      continue
    }
    // Nx throws on a literal before another fallback; left as text, the
    // token is a todo.
    if (i === 0 || i < sources.length - 1) return null
    parts.push({ kind: 'literal', nodes: parseTokens(src) })
  }
  return parts
}

function closingBrace(t: string, open: number): number {
  let depth = 0
  for (let i = open; i < t.length; i++) {
    if (t[i] === '{') depth++
    else if (t[i] === '}' && --depth === 0) return i
  }
  return -1
}

function splitFallbacks(e: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '{') depth++
    else if (e[i] === '}') depth--
    else if (depth === 0 && e.startsWith('??', i)) {
      parts.push(e.slice(start, i))
      start = i + 2
      i++
    }
  }
  parts.push(e.slice(start))
  return parts.map((p) => p.trim())
}

/**
 * `o` with each options token written in; the path tokens stay for
 * {@link nxWorkspacePath}. Null when an option is unset with no fallback,
 * as Nx drops that output; `notText` names an option no path can spell.
 */
function withOptions(
  o: string,
  options: Record<string, unknown>,
): string | { notText: string } | null {
  let notText: string | undefined
  const render = (nodes: readonly NxTokenNode[]): string | null => {
    let s = ''
    for (const n of nodes) {
      const v = typeof n === 'string' ? n : resolve(n)
      if (v === null) return null
      s += v
    }
    return s
  }
  const resolve = (parts: readonly NxTokenPart[]): string | null => {
    for (const p of parts) {
      if (p.kind === 'literal') return render(p.nodes)
      if (p.name !== 'options') return `{${p.name}${p.path === undefined ? '' : `.${p.path}`}}`
      // A dotted path walks the options: @nx/angular:application's
      // `{options.outputPath.base}` read as one key was no output.
      let v: unknown = options
      for (const k of (p.path ?? '').split('.').filter((k) => k !== '')) {
        v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
        if (v === undefined) break
      }
      // Nx 23 drops a falsy option's output; Nx 24 falls back only past an
      // unset or empty one, and a lone token is either's.
      if (parts.length === 1 ? !v : v === undefined || v === null || v === '') continue
      if (typeof v === 'string') return v
      // Nx's template replacement writes a number or a boolean as its text.
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      notText ??= p.path ?? ''
      return ''
    }
    return null
  }
  const s = render(parseTokens(o))
  return notText !== undefined ? { notText } : s
}

/** The options an output reads, by their first key: a forwarded one moves the outputs. */
export function nxOutputOptions(o: string): string[] {
  const names: string[] = []
  const walk = (nodes: readonly NxTokenNode[]): void => {
    for (const n of nodes) {
      if (typeof n === 'string') continue
      for (const p of n) {
        if (p.kind === 'literal') walk(p.nodes)
        else if (p.name === 'options' && p.path !== undefined) names.push(p.path.split('.')[0]!)
      }
    }
  }
  walk(parseTokens(o))
  return names
}

/**
 * An Nx output in vx's glob grammar, or null when it has none. Next's
 * inferred build writes `.next/!(cache)/**\/*`, which vx read as a literal
 * `!(cache)` dir: the build saved nothing and a hit restored no `.next`.
 * A whole-segment `!(a|b)` is `*` with `!` outputs taking `{a,b}` back;
 * the rest is `minimatchToVx`'s.
 */
function vxOutputGlobs(o: string): string[] | null {
  const negated = o.startsWith('!')
  const bare = nxBareGroups(o.slice(negated ? 1 : 0))
  if (bare === null) return null
  const segs = gluedGlobstarAsStar(bare).split('/')
  const at = segs.findIndex((seg) => /^!\([^()|{},]+(\|[^()|{},]+)*\)$/.test(seg))
  if (at !== -1) {
    if (negated) return null
    const alts = segs[at]!.slice(2, -1).split('|')
    const back = alts.length === 1 ? alts[0]! : `{${alts.join(',')}}`
    const pos = vxOutputGlobs([...segs.slice(0, at), '*', ...segs.slice(at + 1)].join('/'))
    const neg = minimatchToVx([...segs.slice(0, at), back, ...segs.slice(at + 1)].join('/'), true)
    return pos === null || neg === null ? null : [...pos, `!${neg}`]
  }
  const g = minimatchToVx(segs.join('/'), negated)
  return g === null ? null : [(negated ? '!' : '') + g]
}

/**
 * The literal paths a project's targets write, workspace-relative. An input
 * inside one is generated: Nx hashes it from disk (TanStack/table's
 * `public` input lists `{projectRoot}/dist` for every `^public`), and vx
 * refuses a path git does not list.
 */
export function nxProjectOutputs(
  targets:
    | Readonly<Record<string, { outputs?: string[]; options?: Record<string, unknown> }>>
    | undefined,
  projectRel: string,
  projectName: string,
): string[] {
  if (targets === undefined) return []
  const known = projectOutputsMemo.get(targets)
  if (known !== undefined) return known
  const out = new Set<string>()
  for (const [name, t] of Object.entries(targets))
    for (const o of nxTargetOutputs(name, t, projectRel, projectName)) out.add(o)
  const r = [...out]
  projectOutputsMemo.set(targets, r)
  return r
}

/** One target's literal output paths, workspace-relative; see {@link nxProjectOutputs}. */
export function nxTargetOutputs(
  name: string,
  t: { outputs?: string[]; options?: Record<string, unknown> },
  projectRel: string,
  projectName: string,
): string[] {
  const scratch: string[] = []
  const rel = projectRel === '.' ? '' : projectRel
  const options = t.options ?? {}
  const { outFiles, wsOutFiles } = mapNxOutputs(
    t.outputs ?? nxDefaultOutputs(name, options, projectRel, scratch),
    options,
    projectRel,
    projectName,
    scratch,
  )
  const literal = (f: string): string | null => {
    const lit = f.replace(/\/\*\*(\/\*)?$/, '')
    return lit.startsWith('!') || /[*?[]|(?<!\\)[{}]/.test(lit)
      ? null
      : lit.replace(/\\([{}!])/g, '$1')
  }
  const out: string[] = []
  for (const f of outFiles) {
    const lit = literal(f)
    if (lit !== null) out.push(path.posix.join(rel, lit))
  }
  for (const f of wsOutFiles) {
    const lit = literal(f)
    if (lit !== null) out.push(lit)
  }
  return out
}

// Keyed on the node's own targets object: every target of a project asks.
const projectOutputsMemo = new WeakMap<object, string[]>()
