// An Nx target's `outputs` as vx's cache outputs: project globs and
// workspace-root globs. Extracted from `buildTask` in item 606.

import path from 'node:path'

interface NxOutputs {
  readonly outFiles: string[]
  readonly wsOutFiles: string[]
}

/**
 * Heuristic: a bare directory path captures its whole subtree. A dot
 * past the first character is an extension (`lcov.info`); a leading
 * one is a hidden DIRECTORY (`.next`, `.output`, `.netlify` — what Nx
 * plugins and router declare), and a bare name for a directory saves
 * nothing: the output scan lists files, never a directory itself.
 */
function dirGlob(rel: string): string {
  const last = rel.split('/').at(-1)!
  return !rel.includes('*') && !last.slice(1).includes('.') ? `${rel}/**` : rel
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
    if (projectRel === '.') outFiles.push(dirGlob(s))
    else if (s.startsWith(`${projectRel}/`)) outFiles.push(dirGlob(s.slice(projectRel.length + 1)))
    else wsOutFiles.push(dirGlob(path.posix.normalize(s).replace(/^\.\//, '')))
  }
  return { outFiles, wsOutFiles }
}
