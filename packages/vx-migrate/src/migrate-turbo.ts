// Turbo → vx migration: the RENDERING half. The mapping itself lives in
// `turbo()` (which runs it live). Each written config holds what its tasks
// declare and nothing else: turbo.json's global block is not carried, and
// each task that lost it says so, for the user to list what it reads.

import path from 'node:path'
import {
  type GeneratedProject,
  type MigrationFormat,
  type MigrationPlan,
  PERSISTENT_TODO,
  quoteTsLiteral as quote,
} from '@vzn/vx'
import type { PackageMeta } from './packages.js'
import { mapTurboWorkspace, type TurboMappedProject } from './turbo/turbo-map.js'
import { rootTaskProject, turboConfigFile } from './turbo/turbo-reads.js'
import { rulesSource, turboBoundaryRules } from './dependency-rules.js'
import type { NxWorkspaceField as WorkspaceField } from './migrate-nx.js'
import { ROOT_ENGINES_PROBE } from './turbo/root-engines.js'
import {
  gitIgnored,
  gitIgnoredUnder,
  spareTrackedTodos,
  trackedFiles,
  trackedKinds,
} from './tracked-outputs.js'
import { DOTENV_GLOBS_HEAD, DOTENV_PROBE, DOTENV_PROBE_TOP } from './dotenv-probe.js'
import { adoptedToolNotes } from './workspace-notes.js'
import { spelledNames } from './spelled-env.js'
import { onceReader, ownBuildInfo, tscBuildInfo, undeclaredTscTodo } from './tsc-buildinfo.js'

/** What a task's `npm_package_*` read: the manifest, so a bump reaches them. */
const MANIFEST_IMPORT = "import pkg from './package.json' with { type: 'json' }"

/** On each task with a command, when turbo.json writes a global field. */
export const GLOBAL_TODO =
  "turbo.json's global block is not carried: list the files and env this task reads in its inputs"

export async function migrateTurbo(
  root: string,
  metas: readonly PackageMeta[],
  format: MigrationFormat = 'ts',
  /** This run writes `.vx/workspace.ts`, with turbo.json's run settings as fields. */
  writesWorkspace = false,
): Promise<MigrationPlan> {
  const tracked = await trackedFiles(root)
  const tsc = onceReader()
  const members = await withRootProject(root, metas)
  const mapping = await mapTurboWorkspace(root, members, {
    ownOnly: true,
    splice: (_, values) => values,
    persistentTodo: PERSISTENT_TODO,
    manifestField: (key) => ({ raw: `pkg.${key}` }),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    // The file this writes is each task's config.
    ownConfig: () => `vx.config.${format}`,
    sourceNames: (dirs) => spelledNames(root, dirs, tracked),
    ignored: (rels) => gitIgnored(root, rels),
    ignoredUnder: (globs) => gitIgnoredUnder(root, globs),
    buildInfo: (rel, command) => tscBuildInfo(tsc.read, path.join(root, rel), command),
    ownBuildInfo: (rel) => ownBuildInfo(tsc.read, path.join(root, rel)),
    tscReach: (rel, command) => {
      const meta = members.find((m) => m.dir === path.join(root, rel))
      return meta === undefined ? null : undeclaredTscTodo(tsc.read, meta, members, command, root)
    },
  })
  // A reader whose `!` hides a committed file under another task's output
  // runs uncached, as under turbo().
  spareTrackedTodos(root, mapping.projects, tracked)

  // vx keys a task on what it declares, nothing global: the user lists
  // what each task reads (M, 2026-11-21).
  const notes = [...mapping.notes]
  if (mapping.dropped.length > 0) {
    notes.push(
      `turbo.json's global block (${mapping.dropped.join(', ')}) is carried onto no task: ` +
        'list what each task reads in its own inputs and exec.env.passThrough',
    )
    for (const p of mapping.projects)
      for (const t of p.tasks) if (t.task?.['exec'] !== undefined) t.todos.push(GLOBAL_TODO)
  }

  const raw = await turboJsonOf(root)
  for (const f of turboFieldsOf(raw))
    if (!writesWorkspace || f.source === undefined) notes.push(f.note)
  notes.push(...turboBoundaryRules(raw).gaps, ...turboKeyNotes(raw))

  // Long values are named once at the top of the config that uses them.
  const shared = hoistTaskEnv(mapping.projects)
  const probes = nameProbes(mapping.projects)
  const decls = declarations(shared.lists, probes.named)
  const projects: GeneratedProject[] = mapping.projects.map((p) => {
    const used = new Set<string>([
      ...(shared.usedBy.get(p.name) ?? []),
      ...(probes.usedBy.get(p.name) ?? []),
    ])
    const readsManifest = p.tasks.some((t) => JSON.stringify(t.task ?? {}).includes('"pkg.'))
    return {
      name: p.name,
      dir: p.dir,
      ...(p.tags !== undefined ? { tags: p.tags } : {}),
      importLines: [
        ...(readsManifest ? [MANIFEST_IMPORT] : []),
        ...decls.filter(([name]) => used.has(name)).map(([, line]) => line),
      ],
      tasks: p.tasks.map(({ name, todos, task }) => ({ name, todos, task })),
    }
  })

  return {
    headerNotes: await adoptedToolNotes(root, {
      plugin: 'turbo',
      config: 'turbo.json',
      runner: 'turbo',
      keys: (lock) => `Turbo keys each package on its own ${lock} entries`,
    }),
    projects,
    extraFiles: [],
    notes,
  }
}

async function turboJsonOf(root: string): Promise<Record<string, unknown> | undefined> {
  const file = await turboConfigFile(root)
  if (file === null) return undefined
  try {
    return (Bun.JSONC.parse(await Bun.file(file).text()) ?? undefined) as
      | Record<string, unknown>
      | undefined
  } catch {
    return undefined // the mapping refuses the file, naming it
  }
}

/** turbo.json's run-wide settings, as `.vx/workspace.ts` fields. */
export async function turboWorkspaceFields(root: string): Promise<WorkspaceField[]> {
  return turboFieldsOf(await turboJsonOf(root))
}

/**
 * turbo.json's top-level settings vx has a home for: `concurrency` (`"4"`,
 * `"50%"`, as `run.concurrency` takes both), `cacheDir` (`cache.dir`) and
 * `boundaries` (`run.rules.dependencies`). Unwritten, a migrated repo that
 * ran four tasks at a time ran on every core and checked no boundary.
 */
function turboFieldsOf(raw: Record<string, unknown> | undefined): WorkspaceField[] {
  if (raw === undefined) return []
  const global = (typeof raw['global'] === 'object' ? raw['global'] : null) as Record<
    string,
    unknown
  > | null
  const out: WorkspaceField[] = []
  const c = global?.['concurrency'] ?? raw['concurrency']
  if (typeof c === 'string' || typeof c === 'number') {
    const v = String(c).trim()
    const source = /^[1-9]\d*$/.test(v) ? v : /^[1-9]\d*%$/.test(v) ? quote(v) : undefined
    out.push({
      field: 'run.concurrency',
      source,
      note:
        source === undefined
          ? `turbo.json \`concurrency: ${JSON.stringify(c)}\` is no count or share of cores: set \`run: { concurrency }\` in .vx/workspace.ts by hand`
          : `turbo.json \`concurrency: ${JSON.stringify(c)}\`: add \`run: { concurrency: ${source} }\` to .vx/workspace.ts`,
    })
  }
  const dir = raw['cacheDir']
  if (typeof dir === 'string' && dir.trim() !== '')
    out.push({
      field: 'cache.dir',
      source: quote(dir.trim()),
      note: `turbo.json \`cacheDir: ${JSON.stringify(dir)}\`: add \`cache: { dir: ${quote(dir.trim())} }\` to .vx/workspace.ts`,
    })
  const { rules } = turboBoundaryRules(raw)
  if (rules.length > 0) {
    const source = rulesSource(rules)
    out.push({
      field: 'run.rules',
      source,
      note: `turbo.json \`boundaries\`: add \`run: { rules: ${source} }\` to .vx/workspace.ts`,
    })
  }
  return out
}

/** turbo.json settings with no vx field, each named with what does the job instead. */
function turboKeyNotes(raw: Record<string, unknown> | undefined): string[] {
  if (raw === undefined) return []
  const out: string[] = []
  const age = raw['cacheMaxAge']
  const size = raw['cacheMaxSize']
  if (typeof age === 'string' || typeof size === 'string')
    out.push(
      `turbo.json ${[typeof age === 'string' ? `\`cacheMaxAge: ${JSON.stringify(age)}\`` : '', typeof size === 'string' ? `\`cacheMaxSize: ${JSON.stringify(size)}\`` : ''].filter(Boolean).join(' and ')}: vx evicts on demand — run \`vx cache clean${typeof age === 'string' ? ` --older-than ${age}` : ''}${typeof size === 'string' ? ` --max-size ${size}` : ''}\``,
    )
  if (raw['experimentalObservability'] !== undefined)
    out.push(
      'turbo.json `experimentalObservability`: declare `otel()` from @vzn/vx-otel in .vx/workspace.ts to export run and task telemetry',
    )
  return out
}

/**
 * The workspace root as a project when turbo.json declares `//#` tasks and no
 * glob lists the root: the `vx.config.ts` written there is what makes core read
 * it as one, as `turbo()`'s `discover` hook does live. Five of eleven real
 * Turbo repos had root tasks, and 36 edges to them were dropped.
 */
async function withRootProject(
  root: string,
  metas: readonly PackageMeta[],
): Promise<readonly PackageMeta[]> {
  const named = await rootTaskProject(root)
  // A root the globs list already is a project of this name; a package
  // that took the name leaves the root none to take.
  if (named === null || metas.some((m) => m.name === named.name)) return metas
  const packageJson = (await Bun.file(path.join(root, 'package.json')).json()) as never
  return [...metas, { ...named, packageJson, configPath: null }]
}

/** A task's own env names, the same in several packages: one named list. */
interface SharedList {
  readonly name: string
  readonly task: string
  readonly values: readonly string[]
}

/** Fewer names than this stay inline: a name costs more than it saves. */
const HOIST_MIN = 3

/**
 * Turbo states a task's `env` once, in the root turbo.json; written inline,
 * vercel/ai's 63 `build` names repeated twice in each of ~100 configs. A
 * task's own `inputs.env` names that two or more configs share are named
 * once at the top of each config, spread where they stood
 * and where they lead `exec.env.passThrough` (its `passThroughEnv` names
 * follow): the evaluated arrays, and so every key, are unchanged. A
 * package whose list differs (its own turbo.json) keeps it inline unless
 * that list is shared too.
 */
function hoistTaskEnv(projects: readonly TurboMappedProject[]): {
  lists: SharedList[]
  usedBy: Map<string, Set<string>>
} {
  const lists = (t: Task): (unknown[] | undefined)[] => [t.inputs?.env, t.exec?.env?.passThrough]
  // The trailing run of names, or null when the list mixes in a spread.
  const own = (list: unknown[] | undefined): string[] | null => {
    if (list === undefined) return null
    const at = list.findIndex((v) => typeof v === 'string')
    if (at < 0 || list.slice(at).some((v) => typeof v !== 'string')) return null
    return list.slice(at) as string[]
  }
  const keyOf = (task: string, names: readonly string[]) => JSON.stringify([task, names])
  const counts = new Map<string, number>()
  for (const p of projects)
    for (const t of p.tasks) {
      if (t.task === null) continue
      const names = own((t.task as Task).inputs?.env)
      if (names === null || names.length < HOIST_MIN) continue
      const k = keyOf(t.name, names)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  // Per task, the most used list takes `<task>Env`, the next `<task>Env2`.
  const ranked = [...counts]
    .filter(([, n]) => n >= 2)
    .sort(([a, m], [b, n]) => n - m || (a < b ? -1 : 1))
  const taken = new Set<string>()
  const nameOf = new Map<string, string>()
  const shared: SharedList[] = []
  for (const [k] of ranked) {
    const [task, values] = JSON.parse(k) as [string, string[]]
    const base = `${identifier(task)}Env`
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`
    taken.add(name)
    nameOf.set(k, name)
    shared.push({ name, task, values })
  }
  const usedBy = new Map<string, Set<string>>()
  for (const p of projects)
    for (const t of p.tasks) {
      if (t.task === null) continue
      const env = own((t.task as Task).inputs?.env)
      const name = env === null ? undefined : nameOf.get(keyOf(t.name, env))
      if (name === undefined) continue
      for (const list of lists(t.task)) {
        const names = own(list)
        if (names === null || list === undefined) continue
        if (!env!.every((n, i) => names[i] === n)) continue
        list.splice(list.length - names.length, env!.length, { raw: `...${name}` })
        let used = usedBy.get(p.name)
        if (used === undefined) usedBy.set(p.name, (used = new Set()))
        used.add(name)
      }
    }
  return { lists: shared.sort((a, b) => (a.name < b.name ? -1 : 1)), usedBy }
}

type Task = {
  inputs?: { env?: unknown[] }
  exec?: { env?: { passThrough?: unknown[] } }
}

/** `test:update` → `testUpdate`; a leading digit gets a `task` prefix. */
function identifier(task: string): string {
  const words = task.split(/[^A-Za-z0-9]+/).filter((w) => w !== '')
  const id = words
    .map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1)))
    .join('')
  return id === '' || /^[0-9]/.test(id) ? `task${id[0]?.toUpperCase() ?? ''}${id.slice(1)}` : id
}

/**
 * The probes, by name: Turbo hashes a task's `.env` files although git
 * ignores them, and a glob over git's files sees none, so the mapper keys
 * them through a shell line that prints each file; and the root's
 * `engines`, which Turbo folds into every task. Inline in every package's
 * config, each line read as noise nobody could review.
 */
type Probe = { name: string; command: string }

const PROBES: readonly Probe[] = [
  {
    name: 'dotenvFiles',
    command: DOTENV_PROBE_TOP,
  },
  {
    name: 'dotenvFilesDeep',
    command: DOTENV_PROBE,
  },
  {
    name: 'rootEngines',
    command: ROOT_ENGINES_PROBE,
  },
]

function nameProbes(projects: readonly TurboMappedProject[]): {
  named: Probe[]
  usedBy: Map<string, Set<string>>
} {
  const named: Probe[] = []
  const rootGlobs: Probe[] = []
  const usedBy = new Map<string, Set<string>>()
  const probeFor = (v: unknown): Probe | undefined => {
    const known = PROBES.find((x) => x.command === v) ?? rootGlobs.find((x) => x.command === v)
    if (known !== undefined || typeof v !== 'string' || !v.startsWith(DOTENV_GLOBS_HEAD))
      return known
    // Each root `.env` glob set is its own line; the globals' is the one most share.
    const probe: Probe = {
      name: `dotenvRootFiles${rootGlobs.length === 0 ? '' : rootGlobs.length + 1}`,
      command: v,
    }
    rootGlobs.push(probe)
    return probe
  }
  for (const p of projects)
    for (const t of p.tasks) {
      const inputs = t.task?.['inputs'] as Record<string, unknown> | undefined
      for (const field of ['runtime', 'workspaceRuntime']) {
        const list = inputs?.[field]
        if (!Array.isArray(list)) continue
        list.forEach((v, i) => {
          const probe = probeFor(v)
          if (probe === undefined) return
          list[i] = { raw: probe.name }
          if (!named.includes(probe)) named.push(probe)
          let used = usedBy.get(p.name)
          if (used === undefined) usedBy.set(p.name, (used = new Set()))
          used.add(probe.name)
        })
      }
    }
  const order = [...PROBES, ...rootGlobs]
  return { named: named.sort((a, b) => order.indexOf(a) - order.indexOf(b)), usedBy }
}

/** Each named value as `[name, 'const name = …']`. */
function declarations(shared: readonly SharedList[], probes: readonly Probe[]): [string, string][] {
  // An env name a user hand-wrote may hold a `'`, `\` or newline: quoted, or
  // the config would not load.
  const arr = (xs: string[]): string => `[${xs.map(quote).join(', ')}]`
  const out: [string, string][] = []
  const add = (name: string, value: string) => out.push([name, `const ${name} = ${value}`])
  for (const l of shared) add(l.name, arr([...l.values]))
  for (const probe of probes) add(probe.name, quote(probe.command))
  return out
}
