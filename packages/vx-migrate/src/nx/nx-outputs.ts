// An Nx target's `outputs` as vx's cache outputs: project globs and
// workspace-root globs. Extracted from `buildTask` in item 606.

import path from 'node:path'
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
 * nothing (item 1052). The last two are left out with a todo: vx cleans an
 * output before the task runs, and a project's `build/` or `public/` is as
 * often its committed sources, which Nx, never cleaning, leaves alone.
 */
export function nxDefaultOutputs(
  targetName: string,
  options: Record<string, unknown>,
  projectRel: string,
  todos: string[],
): string[] {
  if (typeof options['outputPath'] === 'string') return [options['outputPath']]
  if (targetName !== 'build' && targetName !== 'prepare') return []
  const root = projectRel === '.' ? '' : projectRel
  const at = (p: string): string => path.posix.join(root, p)
  todos.push(
    `no outputs declared: Nx also caches ${at('build')} and ${at('public')} for this target — vx cleans an output before the run, so add them to the outputs by hand only if they hold nothing committed`,
  )
  // The root project's two are one path.
  return [...new Set([path.posix.join('dist', root), at('dist')])]
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
      const v = options[optTok[1]!]
      // Nx leaves a falsy option's token in place and drops the output
      // (`getOutputsForTargetAndConfiguration`): @nx/eslint's
      // `{options.outputFile}` with no outputFile is no output, not a todo
      // on every lint target (2026-09-28).
      if (!v) continue outputs
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
    if (projectRel === '.') outFiles.push(neg + s)
    else if (s.startsWith(`${projectRel}/`)) outFiles.push(neg + s.slice(projectRel.length + 1))
    else wsOutFiles.push(neg + path.posix.normalize(s).replace(/^\.\//, ''))
  }
  return { outFiles: takingBack(outFiles), wsOutFiles: takingBack(wsOutFiles) }
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
