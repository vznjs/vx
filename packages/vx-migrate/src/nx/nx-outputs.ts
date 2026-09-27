// An Nx target's `outputs` as vx's cache outputs: project globs and
// workspace-root globs. Extracted from `buildTask` in item 606.

import path from 'node:path'

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
    // Nx takes `!` outputs; vx's outputs cannot exclude, and a mapped `!`
    // glob made core refuse the project's whole config, so no task of it
    // ran (item 1051). Dropped: the positive outputs save a little more.
    if (o.startsWith('!')) {
      todos.push(
        `output ${JSON.stringify(o)}: vx outputs cannot exclude — the other outputs also save what it excludes`,
      )
      continue
    }
    let s = o
    // Every `{options.x}`, not the first: `dist/{options.a}/{options.b}`.
    for (const optTok of o.matchAll(/\{options\.([^}]+)\}/g)) {
      const v = options[optTok[1]!]
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
    if (projectRel === '.') outFiles.push(s)
    else if (s.startsWith(`${projectRel}/`)) outFiles.push(s.slice(projectRel.length + 1))
    else wsOutFiles.push(path.posix.normalize(s).replace(/^\.\//, ''))
  }
  return { outFiles, wsOutFiles }
}
