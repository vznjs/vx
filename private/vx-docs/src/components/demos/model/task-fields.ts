// The tasks page's two widgets, as plain functions the test can call.
// `dependsOn`: which tasks of a three-project workspace one entry on
// `web#build` waits for. Outputs: whether a declared path must exist.

/** The sample workspace: `web` imports `ui`, `api` stands alone. */
export const WORKSPACE: Record<string, readonly string[]> = {
  ui: ['build', 'test'],
  api: ['build', 'test'],
  web: ['gen-icons', 'gen-routes', 'lint', 'build', 'test'],
}
/** Who imports whom: what `^` follows. */
const IMPORTS: Record<string, readonly string[]> = { web: ['ui'], ui: [], api: [] }

export type Waits = { ok: true; tasks: string[] } | { ok: false; why: string }

const name = /^[\w.-]+$/

/** The tasks `web#build` waits on for one `dependsOn` entry. */
export function waitsOn(entry: string, project = 'web'): Waits {
  const e = entry.trim()
  if (e === '') return { ok: false, why: 'type a task name' }
  if (e === '*' || e === '^*') return { ok: false, why: 'a bare * is refused: name the tasks' }
  if (e.startsWith('!')) return { ok: false, why: 'dependsOn has no ! (that is inputs.tasks)' }
  const upstream = e.startsWith('^')
  const rest = upstream ? e.slice(1) : e
  const hash = rest.indexOf('#')
  if (upstream && hash >= 0) return { ok: false, why: 'use ^name or pkg#name, not both' }
  if (!upstream && (rest === 'build' || rest === `${project}#build`))
    return { ok: false, why: 'a task cannot wait for itself: that is a cycle' }
  const projects = hash >= 0 ? [rest.slice(0, hash)] : upstream ? IMPORTS[project]! : [project]
  const task = hash >= 0 ? rest.slice(hash + 1) : rest
  if (!/^[\w.*-]+$/.test(task)) return { ok: false, why: `${task} is not a task name` }
  const re = new RegExp(`^${task.replace(/[.-]/g, '\\$&').replaceAll('*', '.*')}$`)
  const tasks: string[] = []
  for (const p of projects) {
    const own = WORKSPACE[p]
    if (own === undefined) return { ok: false, why: `no project named ${p}: the run is refused` }
    for (const t of own)
      if (re.test(t) && !(p === project && t === 'build')) tasks.push(`${p}#${t}`)
  }
  if (tasks.length === 0 && !upstream && name.test(task))
    return { ok: false, why: `${projects[0]} has no task ${task}: the run is refused` }
  return { ok: true, tasks }
}

/** A declared output with a wildcard may match nothing; a plain path must exist. */
export function outputRule(pattern: string): 'required' | 'optional' | 'empty' {
  const p = pattern.trim().replace(/^!/, '')
  if (p === '') return 'empty'
  return /[*?[\]{}]/.test(p) ? 'optional' : 'required'
}
