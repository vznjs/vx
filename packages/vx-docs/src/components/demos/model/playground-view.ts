// What the playground page computes (learn/playground, item 700;
// design/playground-ui-2026-09.md). `<vx-playground>` only wires these to
// the DOM, and `Playground.astro` renders the static table from them at
// build time, so the rows in tests/playground-view.test.ts hold both.
//
// `runPlayground` is the page's Run: core's discovery picks each project's
// config file, the page evaluates its text, and vx's planner plans with the
// reader's files, env, task specs and simulated cache. The planner is
// passed in: the element imports it from the site on the first Run, the
// tests from a fresh build of the same bundle, and core's parity row
// (packages/vx/tests/playground-parity.unsafe.test.ts) holds what this
// returns for the page's workspace to `vx run --dry=json`.

import type {
  PlaygroundInput,
  PlaygroundProject,
  PlaygroundResult,
  PlaygroundTask,
} from '../../../playground/entry.js'

export type { PlaygroundTask }

/** The bundle's exports the page calls (`playground/planner.js`). */
export interface Planner {
  evaluateConfig(
    text: string,
    deadlineMs: number,
  ): Promise<{ ok: true; config: unknown } | { ok: false; error: string }>
  listPlaygroundProjects(
    input: Pick<PlaygroundInput, 'root' | 'files'>,
  ): Promise<PlaygroundProject[]>
  planPlayground(input: PlaygroundInput): Promise<PlaygroundResult>
}

/** Where the workspace sits in the planner's virtual file system. */
export const PLAYGROUND_ROOT = '/toy'
/** How long one config may take to evaluate before its Worker is terminated. */
export const EVAL_DEADLINE_MS = 2000

export interface RunInput {
  files: Record<string, string>
  env: Record<string, string>
  tasks: string[]
  /** The simulated cache: every key a run before this one planned. */
  cached: ReadonlySet<string>
}

export type RunOutcome =
  | {
      ok: true
      /** In the order of their projects' config files in the file list. */
      tasks: PlaygroundTask[]
      dispatchOrder: string[]
      /** The cache after this run: it saves every key it planned. */
      cached: Set<string>
    }
  | { ok: false; errors: string[] }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function runPlayground(planner: Planner, input: RunInput): Promise<RunOutcome> {
  const root = PLAYGROUND_ROOT
  let projects: PlaygroundProject[]
  try {
    projects = await planner.listPlaygroundProjects({ root, files: input.files })
  } catch (e) {
    return { ok: false, errors: [messageOf(e)] }
  }
  const withConfig = projects.filter(
    (p): p is PlaygroundProject & { configFile: string } => p.configFile !== null,
  )
  const evaluated = await Promise.all(
    withConfig.map((p) => planner.evaluateConfig(input.files[p.configFile]!, EVAL_DEADLINE_MS)),
  )
  const configs: Record<string, unknown> = {}
  const errors: string[] = []
  for (const [i, p] of withConfig.entries()) {
    const r = evaluated[i]!
    if (r.ok) configs[p.name] = r.config
    else errors.push(`${p.name} (${p.configFile}): ${r.error}`)
  }
  if (errors.length > 0) return { ok: false, errors }

  let result: PlaygroundResult
  try {
    result = await planner.planPlayground({
      root,
      files: input.files,
      configs,
      env: input.env,
      tasks: input.tasks,
      cached: [...input.cached],
    })
  } catch (e) {
    return { ok: false, errors: [messageOf(e)] }
  }
  // The CLI's words for the same two refusals (`vx run --dry`).
  const undeclared = (specs: string[]): RunOutcome => ({
    ok: false,
    errors: [`no projects declare task(s): ${specs.join(', ')}.`],
  })
  if (result.unresolvedTasks.length > 0) return undeclared(result.unresolvedTasks)
  if (result.tasks.length === 0) return undeclared(input.tasks)

  const fileOrder = Object.keys(input.files)
  const projectRank = new Map(withConfig.map((p) => [p.name, fileOrder.indexOf(p.configFile)]))
  const taskRank = (t: PlaygroundTask): number =>
    Object.keys(taskConfigs(configs[t.project])).indexOf(t.task)
  const tasks = [...result.tasks].sort(
    (a, b) =>
      projectRank.get(a.project)! - projectRank.get(b.project)! || taskRank(a) - taskRank(b),
  )
  return {
    ok: true,
    tasks,
    dispatchOrder: result.dispatchOrder,
    cached: new Set([...input.cached, ...tasks.map((t) => t.hash)]),
  }
}

export type KeyChange = 'new' | 'moved' | 'same'

export interface RunRow {
  id: string
  /** The key's 16 hex digits. */
  key: string
  status: string
  change: KeyChange
}

/** The words the results table uses for a plan's cache status. */
function statusOf(cacheStatus: string): string {
  if (cacheStatus === 'hit-local') return 'hit'
  if (cacheStatus === 'no-cache') return 'no cache'
  return cacheStatus
}

/** Each task of `next` against the run before it: a key it had is the same
 *  or moved, and a task that run did not plan (or the first run's) is new. */
export function diffRuns(
  prev: readonly PlaygroundTask[] | undefined,
  next: readonly PlaygroundTask[],
): RunRow[] {
  const before = new Map(prev?.map((t) => [t.id, t.hash]))
  return next.map((t) => {
    const was = before.get(t.id)
    return {
      id: t.id,
      key: t.hash.slice(0, 16),
      status: statusOf(t.cacheStatus),
      change: was === undefined ? 'new' : was === t.hash ? 'same' : 'moved',
    }
  })
}

/** The words the results table's "key moved" column uses. */
export function changeCell(change: KeyChange): string {
  if (change === 'moved') return 'moved'
  if (change === 'new') return 'new'
  return ''
}

const STATUS_ORDER = ['hit', 'miss', 'no cache', 'group']

/** The run in one sentence, for the live region: "9 tasks: 5 hit, 4 miss.
 *  Keys moved: ui#build, ui#test, app#build, app#test." */
export function summarize(rows: readonly RunRow[]): string {
  const count = (s: string): number => rows.filter((r) => r.status === s).length
  const counts = STATUS_ORDER.filter((s) => s === 'hit' || s === 'miss' || count(s) > 0).map(
    (s) => `${count(s)} ${s}`,
  )
  const ids = (c: KeyChange): string[] => rows.filter((r) => r.change === c).map((r) => r.id)
  const moved = ids('moved')
  const fresh = ids('new')
  let keys: string
  if (fresh.length === rows.length) keys = 'Every key is new.'
  else {
    keys = moved.length > 0 ? `Keys moved: ${moved.join(', ')}.` : 'No key moved.'
    if (fresh.length > 0) keys += ` New: ${fresh.join(', ')}.`
  }
  return `${rows.length} task${rows.length === 1 ? '' : 's'}: ${counts.join(', ')}. ${keys}`
}

/** The live region's sentence for a run that failed. */
export function failureSummary(errors: readonly string[], kept: boolean): string {
  const what =
    errors.length === 1 ? 'The run failed' : `The run failed with ${errors.length} errors`
  return kept ? `${what}. The table is the last good run's, marked stale.` : `${what}.`
}

/** `NAME=value` lines into an env. Blank lines and `#` comments are skipped,
 *  the value is everything after the first `=`, and a later line wins. */
export function parseEnv(
  text: string,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {}
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const eq = line.indexOf('=')
    const name = eq === -1 ? '' : line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, error: `env line ${i + 1}: expected NAME=value, got '${line}'` }
    }
    env[name] = line.slice(eq + 1)
  }
  return { ok: true, env }
}

/** An env as the lines `parseEnv` reads back. */
export function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** The task specs field, as `vx run` takes them: whitespace-separated. */
export function parseTasks(
  text: string,
): { ok: true; tasks: string[] } | { ok: false; error: string } {
  const tasks = text.split(/\s+/).filter((t) => t !== '')
  return tasks.length > 0 ? { ok: true, tasks } : { ok: false, error: 'name at least one task' }
}

interface TaskShape {
  dependsOn?: string[]
  cache?: { inputs?: { files?: string[]; env?: string[] } }
}

function taskConfigs(config: unknown): Record<string, TaskShape> {
  return (config as { tasks?: Record<string, TaskShape> } | undefined)?.tasks ?? {}
}

export interface StaticProject {
  name: string
  /** The workspace packages its package.json depends on, in its order. */
  uses: string[]
  /** Its evaluated `vx.config.mjs`. */
  config: unknown
}

export interface StaticRow {
  id: string
  /** The tasks it waits for, as core resolves `^task`, `task` and `pkg#task`. */
  waitsFor: string[]
  files: string[]
  env: string[]
}

/**
 * The task graph as the page opens: one row per task, in project order and
 * each config's task order. The static render shows it without JavaScript,
 * and a row holds `waitsFor` to the deps the planner resolves.
 */
export function staticTable(projects: readonly StaticProject[]): StaticRow[] {
  const has = (project: string, task: string): boolean =>
    task in taskConfigs(projects.find((p) => p.name === project)?.config)
  return projects.flatMap((p) =>
    Object.entries(taskConfigs(p.config)).map(([task, t]) => ({
      id: `${p.name}#${task}`,
      waitsFor: (t.dependsOn ?? []).flatMap((d) => {
        if (d.startsWith('^')) {
          return p.uses.filter((u) => has(u, d.slice(1))).map((u) => `${u}#${d.slice(1)}`)
        }
        return [d.includes('#') ? d : `${p.name}#${d}`]
      }),
      files: t.cache?.inputs?.files ?? [],
      env: t.cache?.inputs?.env ?? [],
    })),
  )
}

/** A static row's three cells, as the page prints them. */
export function staticCells(r: StaticRow): [string, string, string] {
  return [
    r.id,
    r.waitsFor.length > 0 ? r.waitsFor.join(', ') : 'nothing',
    [...r.files, ...r.env.map((e) => `env ${e}`)].join(', '),
  ]
}

/** The dispatch order in one line. */
export function orderLine(dispatchOrder: readonly string[]): string {
  return `On 2 workers, vx's scheduler dispatches them in this order: ${dispatchOrder.join(', ')}.`
}

/** The page's projects for `staticTable`, from its files and evaluated
 *  configs: each `packages/<dir>/package.json` in file order. */
export function staticProjects(
  files: Record<string, string>,
  configs: Record<string, unknown>,
): StaticProject[] {
  const manifests = Object.entries(files)
    .filter(([f]) => /^packages\/[^/]+\/package\.json$/.test(f))
    .map(([, text]) => JSON.parse(text) as { name: string; dependencies?: Record<string, string> })
  const names = new Set(manifests.map((m) => m.name))
  return manifests
    .filter((m) => m.name in configs)
    .map((m) => ({
      name: m.name,
      uses: Object.keys(m.dependencies ?? {}).filter((d) => names.has(d)),
      config: configs[m.name],
    }))
}
