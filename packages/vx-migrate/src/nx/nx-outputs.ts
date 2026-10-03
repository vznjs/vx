// An Nx target's `outputs` as vx's cache outputs: project globs and
// workspace-root globs. Extracted from `buildTask` in item 606.

import path from 'node:path'
import { minimatchToVx } from '../glob-grammar.js'
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
 */
export function nxWorkspacePath(s: string, projectRel: string, projectName: string): string | null {
  const rel = projectRel === '.' ? '' : projectRel
  const p = s
    .replaceAll('{workspaceRoot}', '')
    .replaceAll('{projectRoot}', rel)
    .replaceAll('{projectName}', projectName)
  // A token left over is a gap; a brace set (`*.{ts,tsx}`) is a glob.
  if (/\{[\w.]+\}/.test(p)) return null
  const n = path.posix.normalize(p.replace(/^\/+/, '')).replace(/^\.\//, '')
  return n === '.' || n === '..' || n.startsWith('../') ? null : n
}

/** A workspace path relative to the project dir, or null when it lies outside. */
export function underProject(p: string, projectRel: string): string | null {
  if (projectRel === '.' || projectRel === '') return p
  return p.startsWith(`${projectRel}/`) ? p.slice(projectRel.length + 1) : null
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
  const at = (p: string): string => path.posix.join(root, p)
  const held = ['build', 'public'].filter((d) => tops === undefined || tops.has(d))
  if (held.length > 0)
    todos.push(
      `no outputs declared: Nx also caches ${held.map(at).join(' and ')} for this target — vx cleans an output before the run, so add ${held.length === 1 ? 'it' : 'them'} to the outputs by hand only if ${held.length === 1 ? 'it holds' : 'they hold'} nothing committed`,
    )
  // The root project's two are one path.
  return [
    ...new Set([path.posix.join('dist', root), at('dist')]),
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
  outputs: for (const o of outputs) {
    // A `!` output takes a path back, as Nx's does (A-44); it maps as its
    // path does and keeps the `!`.
    const neg = o.startsWith('!') ? '!' : ''
    let s = o.slice(neg.length)
    // Every `{options.x}`, not the first: `dist/{options.a}/{options.b}`.
    for (const optTok of o.matchAll(/\{options\.([^}]+)\}/g)) {
      // A dotted path walks the options, as Nx's `_interpolate` does:
      // @nx/angular:application's `{options.outputPath.base}` read as one
      // key was no output, and a cached build's hit restored nothing.
      let v: unknown = options
      for (const k of optTok[1]!.split('.')) {
        v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
        if (!v) break
      }
      // Nx leaves a falsy option's token in place and drops the output
      // (`getOutputsForTargetAndConfiguration`): @nx/eslint's
      // `{options.outputFile}` with no outputFile is no output, not a todo
      // on every lint target (2026-09-28).
      if (!v) continue outputs
      // Nx's template replacement writes a number or a boolean as its text.
      if (typeof v === 'number' || typeof v === 'boolean') {
        s = s.replace(optTok[0], String(v))
        continue
      }
      if (typeof v !== 'string') {
        todos.push(
          `output ${JSON.stringify(o)}: option ${JSON.stringify(optTok[1])} is not a literal ` +
            'string — resolve manually',
        )
        continue outputs
      }
      s = s.replace(optTok[0], v)
    }
    if (s.includes('{')) {
      const p = nxWorkspacePath(s, projectRel, projectName)
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
        `output ${JSON.stringify(o)} resolves to ${JSON.stringify(norm)}, outside the workspace — ` +
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
      if (projectRel === '.') outFiles.push(g)
      else if (gs.startsWith(`${projectRel}/`)) outFiles.push(gn + gs.slice(projectRel.length + 1))
      else wsOutFiles.push(gn + path.posix.normalize(gs).replace(/^\.\//, ''))
    }
  }
  return { outFiles: takingBack(outFiles), wsOutFiles: takingBack(wsOutFiles) }
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
  const segs = o.slice(negated ? 1 : 0).split('/')
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
  const scratch: string[] = []
  const rel = projectRel === '.' ? '' : projectRel
  for (const [name, t] of Object.entries(targets)) {
    const options = t.options ?? {}
    const { outFiles, wsOutFiles } = mapNxOutputs(
      t.outputs ?? nxDefaultOutputs(name, options, projectRel, scratch),
      options,
      projectRel,
      projectName,
      scratch,
    )
    for (const f of [...outFiles.map((f) => path.posix.join(rel, f)), ...wsOutFiles]) {
      const lit = f.replace(/\/\*\*(\/\*)?$/, '')
      if (!lit.startsWith('!') && !/[*?[{]/.test(lit)) out.add(lit)
    }
  }
  const r = [...out]
  projectOutputsMemo.set(targets, r)
  return r
}

// Keyed on the node's own targets object: every target of a project asks.
const projectOutputsMemo = new WeakMap<object, string[]>()
