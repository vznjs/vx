// The run picker's model: which tasks one `vx run` starts in the Running
// tasks page's shop workspace. Four projects, three tasks; `build` and
// `test` wait on `^build`, `lint` on nothing. Pure, so
// tests/run-picker.test.ts holds it to the plans real vx printed for the
// same workspace.

export const PROJECTS = ['@shop/ui', '@shop/web', '@shop/admin', '@shop/api'] as const
export type Project = (typeof PROJECTS)[number]
export const TASKS = ['build', 'test', 'lint'] as const
export type Task = (typeof TASKS)[number]

/** What each project uses (a lockfile plugin's edges). */
export const USES: Record<Project, Project[]> = {
  '@shop/ui': [],
  '@shop/web': ['@shop/ui'],
  '@shop/admin': ['@shop/ui'],
  '@shop/api': [],
}

const DIR: Record<Project, string> = {
  '@shop/ui': 'packages/ui',
  '@shop/web': 'packages/web',
  '@shop/admin': 'packages/admin',
  '@shop/api': 'packages/api',
}

/** `build` and `test` declare `dependsOn: ['^build']`. */
const waitsOnBuild = (task: Task): boolean => task !== 'lint'

export type Scope =
  | { kind: 'here'; project: Project }
  | { kind: 'all' }
  | { kind: 'filter'; filters: string[] }
  | { kind: 'affected'; changed: Project[] }

/** Each planned task id, `requested` when asked for, `first` when another needs it. */
export interface Plan {
  tasks: { id: string; role: 'requested' | 'first' }[]
  error?: string
}

const usersOf = (p: Project): Project[] => PROJECTS.filter((q) => USES[q].includes(p))

function closure(start: Project[], step: (p: Project) => Project[]): Set<Project> {
  const seen = new Set<Project>()
  const todo = [...start]
  while (todo.length > 0) {
    const p = todo.pop()!
    for (const q of step(p)) {
      if (!seen.has(q)) {
        seen.add(q)
        todo.push(q)
      }
    }
  }
  return seen
}

function nameMatch(pattern: string): Project[] {
  if (pattern.startsWith('./') || pattern.startsWith('{')) {
    const dir = pattern
      .replace(/^\{|\}$/g, '')
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
    const re = globRe(dir)
    return PROJECTS.filter((p) => re.test(DIR[p]) || DIR[p].startsWith(`${dir}/`))
  }
  const re = globRe(pattern)
  const hit = PROJECTS.filter((p) => re.test(p))
  // pnpm reads a pattern that matches no name without its scope.
  return hit.length > 0 ? hit : PROJECTS.filter((p) => re.test(p.replace(/^@[^/]+\//, '')))
}

function globRe(glob: string): RegExp {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${body}$`)
}

/** One `--filter` pattern's projects, or why it is refused. */
export function filterProjects(
  raw: string,
): { include: boolean; projects: Project[] } | { error: string } {
  let f = raw.trim().replace(/^['"]|['"]$/g, '')
  const include = !f.startsWith('!')
  if (!include) f = f.slice(1)
  let deps: 'none' | 'with' | 'only' = 'none'
  let users: 'none' | 'with' | 'only' = 'none'
  if (f.startsWith('...^')) [users, f] = ['only', f.slice(4)]
  else if (f.startsWith('...')) [users, f] = ['with', f.slice(3)]
  if (f.endsWith('^...')) [deps, f] = ['only', f.slice(0, -4)]
  else if (f.endsWith('...')) [deps, f] = ['with', f.slice(0, -3)]
  if (f === '') return { error: `"${raw}" names no project` }
  const matched = nameMatch(f)
  if (matched.length === 0) {
    const near = PROJECTS.find((p) => distance(p, f) <= 2 || distance(p.slice(6), f) <= 2)
    return {
      error: `no projects matched filter(s): "${raw}"${near ? ` · fix ${raw.replace(f, near)}` : ''}`,
    }
  }
  const out = new Set<Project>(deps === 'only' || users === 'only' ? [] : matched)
  if (deps !== 'none') for (const p of closure(matched, (p) => USES[p])) out.add(p)
  if (users !== 'none') for (const p of closure(matched, usersOf)) out.add(p)
  return { include, projects: PROJECTS.filter((p) => out.has(p)) }
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return d[b.length]!
}

/** The projects a scope selects, or why the run is refused. */
export function select(scope: Scope): Project[] | { error: string } {
  if (scope.kind === 'here') return [scope.project]
  if (scope.kind === 'all') return [...PROJECTS]
  if (scope.kind === 'affected') return [...PROJECTS]
  if (scope.filters.length === 0) return { error: 'type a filter' }
  const inc = new Set<Project>()
  const exc = new Set<Project>()
  let onlyExcludes = true
  for (const f of scope.filters) {
    const r = filterProjects(f)
    if ('error' in r) return r
    if (r.include) onlyExcludes = false
    for (const p of r.projects) (r.include ? inc : exc).add(p)
  }
  // An exclusion alone takes from every project, as `--all --filter '!x'`.
  if (onlyExcludes) for (const p of PROJECTS) inc.add(p)
  const out = PROJECTS.filter((p) => inc.has(p) && !exc.has(p))
  return out.length > 0 ? out : { error: 'no projects selected: the exclusions took every match' }
}

/** The plan for `vx run <task>` over a scope. */
export function plan(task: Task, scope: Scope): Plan {
  const picked = select(scope)
  if (!Array.isArray(picked)) return { tasks: [], error: picked.error }
  const roles = new Map<string, 'requested' | 'first'>()
  const need = (p: Project, t: Task, role: 'requested' | 'first') => {
    const id = `${p}#${t}`
    if (roles.get(id) === 'requested') return
    if (role === 'first' && roles.has(id)) return
    roles.set(id, role)
    if (waitsOnBuild(t)) for (const d of USES[p]) need(d, 'build', 'first')
  }
  let requested: Project[] = picked
  if (scope.kind === 'affected') {
    // A change marks the changed projects' tasks; a task runs when its
    // dependsOn closure holds a marked one, so ^build carries it on.
    const marked = new Set(scope.changed)
    const reach = (p: Project): boolean =>
      marked.has(p) || (waitsOnBuild(task) && USES[p].some((d) => reachBuild(d)))
    const reachBuild = (p: Project): boolean => marked.has(p) || USES[p].some((d) => reachBuild(d))
    requested = PROJECTS.filter(reach)
  }
  for (const p of requested) need(p, task, 'requested')
  const tasks = [...roles].map(([id, role]) => ({ id, role }))
  tasks.sort((a, b) => a.id.localeCompare(b.id))
  return { tasks }
}

/** The command line a scope stands for. */
export function command(task: Task, scope: Scope): string {
  switch (scope.kind) {
    case 'here':
      return `vx run ${task}`
    case 'all':
      return `vx run ${task} --all`
    case 'affected':
      return `vx run ${task} --affected`
    case 'filter':
      return `vx run ${task} ${scope.filters.map((f) => `--filter '${f}'`).join(' ')}`.trim()
  }
}
