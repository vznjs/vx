// An Nx target's `outputs` as vx's cache outputs: project globs and
// workspace-root globs. Extracted from `buildTask` in item 606; the rules
// are unchanged.

import path from 'node:path'

export interface NxOutputs {
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

/** `outputs` with `{options.x}` resolved against `options`; `projectRel` is the project dir, `.` for the root. */
export function mapNxOutputs(
  outputs: readonly string[],
  options: Record<string, unknown>,
  projectRel: string,
  todos: string[],
): NxOutputs {
  const outFiles: string[] = []
  const wsOutFiles: string[] = []
  for (const o of outputs) {
    let s = o
    const optTok = /\{options\.([^}]+)\}/.exec(s)
    if (optTok) {
      const v = options[optTok[1]!]
      if (typeof v !== 'string') {
        todos.push(
          `output ${JSON.stringify(o)}: option ${JSON.stringify(optTok[1])} is not a literal ` +
            'string — resolve manually',
        )
        continue
      }
      s = s.replace(optTok[0], v)
    }
    if (s.startsWith('{projectRoot}/')) {
      outFiles.push(dirGlob(s.slice('{projectRoot}/'.length)))
      continue
    }
    if (s.startsWith('{workspaceRoot}/')) {
      wsOutFiles.push(dirGlob(s.slice('{workspaceRoot}/'.length)))
      continue
    }
    if (s.includes('{')) {
      todos.push(`output ${JSON.stringify(o)} uses a token vx does not support`)
      continue
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
