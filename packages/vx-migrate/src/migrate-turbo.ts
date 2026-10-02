// Turbo → vx migration: the RENDERING half. The mapping itself lives in
// `turbo()` (which runs it live); this file turns turbo's global
// fields into a root vx-preset.ts that each generated config imports and
// spreads — TypeScript composition replaces turbo's global config.

import { readdirSync } from 'node:fs'
import path from 'node:path'
import {
  type GeneratedProject,
  type MigrationFormat,
  type MigrationPlan,
  PERSISTENT_TODO,
  type ProjectMeta,
  quoteTsLiteral as quote,
} from '@vzn/vx'
import {
  mapTurboWorkspace,
  rootTaskProject,
  type TurboGlobal,
  type TurboMappedProject,
} from './turbo/turbo-map.js'
import { relPosix } from './paths.js'
import { gitIgnored, trackedFiles, trackedKinds } from './tracked-outputs.js'
import { DOTENV_GLOBS_HEAD, DOTENV_PROBE, DOTENV_PROBE_TOP } from './dotenv-probe.js'

/** What a task's `npm_package_*` read: the manifest, so a bump reaches them. */
const MANIFEST_IMPORT = "import pkg from './package.json' with { type: 'json' }"

/** The preset takes the configs' extension: plain arrays either way. */
function presetFile(format: MigrationFormat): string {
  return `vx-preset.${format}`
}

/** The preset export each global field becomes. */
const PRESET_NAMES: Record<TurboGlobal, string> = {
  inputs: 'globalInputs',
  env: 'globalEnvInputs',
  pass: 'globalPassThroughEnv',
}

export async function migrateTurbo(
  root: string,
  metas: readonly ProjectMeta[],
  format: MigrationFormat = 'ts',
): Promise<MigrationPlan> {
  const tracked = await trackedFiles(root)
  const mapping = await mapTurboWorkspace(root, await withRootProject(root, metas), {
    splice: (kind) => [{ raw: `...${PRESET_NAMES[kind]}` }],
    persistentTodo: PERSISTENT_TODO,
    manifestField: (key) => ({ raw: `pkg.${key}` }),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    // The file this writes is each task's config.
    ownConfig: () => `vx.config.${format}`,
    ignored: (rels) => gitIgnored(root, rels),
  })

  const shared = hoistTaskEnv(mapping.projects)
  const probes = nameProbes(mapping.projects)
  const projects: GeneratedProject[] = mapping.projects.map((p) => {
    const used = new Set<string>([
      ...(shared.usedBy.get(p.name) ?? []),
      ...(probes.usedBy.get(p.name) ?? []),
    ])
    for (const t of p.tasks) for (const kind of t.uses) used.add(PRESET_NAMES[kind])
    const readsManifest = p.tasks.some((t) => JSON.stringify(t.task ?? {}).includes('"pkg.'))
    return {
      name: p.name,
      dir: p.dir,
      importLines: [
        ...(readsManifest ? [MANIFEST_IMPORT] : []),
        ...presetImportLines(used, root, p.dir, format),
      ],
      tasks: p.tasks.map(({ name, todos, task }) => ({ name, todos, task })),
    }
  })

  const { inputs, env, pass } = mapping.globals
  const extraFiles: MigrationPlan['extraFiles'] = []
  if (
    inputs.length > 0 ||
    env.length > 0 ||
    pass.length > 0 ||
    shared.lists.length > 0 ||
    probes.named.length > 0
  ) {
    extraFiles.push({
      relPath: presetFile(format),
      contents: renderPreset(inputs, env, pass, shared.lists, probes.named),
    })
  }

  return { headerNotes: await turboStillDeclared(root), projects, extraFiles, notes: mapping.notes }
}

/**
 * `vx init` declares `turbo()` beside turbo.json, and after the migration
 * it still read turbo.json every run, filling any task the configs leave
 * out, with nothing saying it is now redundant: the configs ARE the
 * mapping. The repo is native once it goes.
 */
async function turboStillDeclared(root: string): Promise<string[]> {
  for (const name of readdirSync(root)) {
    if (!/^vx\.workspace\.(ts|mts|js|mjs|cts|cjs)$/.test(name)) continue
    const text = await Bun.file(path.join(root, name)).text()
    if (/\bturbo\s*\(/.test(text))
      return [
        `${name} still declares turbo(), which reads turbo.json every run and fills any task ` +
          'a vx.config does not declare; the configs written here declare them all. Once ' +
          '`vx run` does what turbo did, remove turbo() (and its import), then turbo.json',
      ]
  }
  return []
}

/**
 * The workspace root as a project when turbo.json declares `//#` tasks and
 * no glob lists the root: the `vx.config.ts` written there is what makes
 * core read it as one (D-39), as `turbo()`'s `discover` hook does live.
 * Five of eleven real Turbo repos had root
 * tasks, and 36 edges to them were dropped (G-49).
 */
async function withRootProject(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<readonly ProjectMeta[]> {
  const named = await rootTaskProject(root)
  // A root the globs list already is a project of this name; a package
  // that took the name leaves the root none to take.
  if (named === null || metas.some((m) => m.name === named.name)) return metas
  const packageJson = (await Bun.file(path.join(root, 'package.json')).json()) as never
  return [...metas, { ...named, packageJson, configPath: null }]
}

function presetImportLines(
  used: ReadonlySet<string>,
  root: string,
  dir: string,
  format: MigrationFormat,
): string[] {
  if (used.size === 0) return []
  // `.js` for the `.ts` file: Bun takes it to the `.ts`, and a user's
  // `tsc` accepts it under every resolution mode, where `.ts` fails
  // without `allowImportingTsExtensions` (TS5097; create-t3-turbo).
  const file = format === 'ts' ? 'vx-preset.js' : presetFile(format)
  const rel = relPosix(dir, path.join(root, file))
  const spec = rel.startsWith('.') ? rel : `./${rel}`
  return [`import { ${[...used].sort().join(', ')} } from '${spec}'`]
}

/** A task's own env names, the same in several packages: one preset export. */
interface SharedList {
  readonly name: string
  readonly task: string
  readonly values: readonly string[]
}

/** Fewer names than this stay inline: an import costs more than it saves. */
const HOIST_MIN = 3

/**
 * Turbo states a task's `env` once, in the root turbo.json; written inline,
 * vercel/ai's 63 `build` names repeated twice in each of ~100 configs. A
 * task's own `cache.inputs.env` names (after the spliced globals) that two
 * or more configs share become one preset export, spread where they stood
 * and where they lead `exec.env.passThrough` (its `passThroughEnv` names
 * follow): the evaluated arrays, and so every key, are unchanged. A
 * package whose list differs (its own turbo.json) keeps it inline unless
 * that list is shared too.
 */
function hoistTaskEnv(projects: readonly TurboMappedProject[]): {
  lists: SharedList[]
  usedBy: Map<string, Set<string>>
} {
  const lists = (t: Task): (unknown[] | undefined)[] => [
    t.cache?.inputs?.env,
    t.exec?.env?.passThrough,
  ]
  // The trailing run of names after the spliced globals, or null when the
  // list is all names or mixes them in.
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
      const names = own((t.task as Task).cache?.inputs?.env)
      if (names === null || names.length < HOIST_MIN) continue
      const k = keyOf(t.name, names)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  // Per task, the most used list takes `<task>Env`, the next `<task>Env2`.
  const ranked = [...counts]
    .filter(([, n]) => n >= 2)
    .sort(([a, m], [b, n]) => n - m || (a < b ? -1 : 1))
  const taken = new Set(Object.values(PRESET_NAMES))
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
      const env = own((t.task as Task).cache?.inputs?.env)
      const name = env === null ? undefined : nameOf.get(keyOf(t.name, env))
      if (name === undefined) continue
      for (const list of lists(t.task as Task)) {
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
  cache?: { inputs?: { env?: unknown[] } }
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
 * The `.env` probes, by name: Turbo hashes a task's `.env` files although
 * git ignores them, and a glob over git's files sees none, so the mapper
 * keys them through a shell line that prints each file. Inline in every
 * package's config, that line read as noise nobody could review.
 */
type Probe = { name: string; command: string; doc: string; field: string }

const PROBES: readonly Probe[] = [
  {
    name: 'dotenvFiles',
    command: DOTENV_PROBE_TOP,
    doc: "Each `.env` file in the task's directory, name and bytes",
    field: 'runtime',
  },
  {
    name: 'dotenvFilesDeep',
    command: DOTENV_PROBE,
    doc: "Each `.env` file under the task's directory, name and bytes",
    field: 'runtime',
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
      doc: "The `.env` files the workspace's root globs name, name and bytes",
      field: 'workspaceRuntime',
    }
    rootGlobs.push(probe)
    return probe
  }
  for (const p of projects)
    for (const t of p.tasks) {
      const inputs = (t.task?.['cache'] as { inputs?: Record<string, unknown> } | undefined)?.inputs
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

function renderPreset(
  inputs: string[],
  env: string[],
  pass: string[],
  shared: readonly SharedList[],
  probes: readonly Probe[],
): string {
  // Escape each entry via the shared `quote()` — a turbo.json global (a file
  // glob, or an env name a user hand-wrote) may contain a `'`/`\`/newline that
  // would otherwise splice into a malformed, unloadable `vx-preset.ts`.
  const arr = (xs: string[]): string => `[${xs.map(quote).join(', ')}]`
  const lines = [
    // The same name the configs carry (`verb` in index.ts): `vx migrate` is
    // no verb, and a reader who typed it got `unknown command`.
    '// Generated by `vx-migrate` from turbo.json. TypeScript composition',
    "// replaces turbo's global fields: each vx.config.ts imports these",
    '// arrays and spreads them into the matching task fields.',
  ]
  if (inputs.length > 0) {
    lines.push(
      '',
      '// From globalDependencies and what Turbo adds to them (the packages the',
      '// root depends on, microfrontends configs) — workspace-root-relative,',
      '// spread into each task’s cache.inputs.workspaceFiles.',
      `export const globalInputs = ${arr(inputs)}`,
    )
  }
  if (env.length > 0) {
    lines.push(
      '',
      '// From globalEnv: cache inputs AND passed through to every task',
      '// (vx child environments are isolated; see docs/schema.md).',
      `export const globalEnvInputs = ${arr(env)}`,
    )
  }
  if (pass.length > 0) {
    lines.push(
      '',
      '// From globalPassThroughEnv: forwarded to every task, never hashed.',
      `export const globalPassThroughEnv = ${arr(pass)}`,
    )
  }
  for (const l of shared)
    lines.push(
      '',
      `// turbo.json's \`${l.task}\` env: hashed and passed where a config spreads it.`,
      `export const ${l.name} = ${arr([...l.values])}`,
    )
  for (const probe of probes) {
    lines.push(
      '',
      `// ${probe.doc}. Turbo hashes`,
      "// `.env` files although git ignores them, and a glob over git's files",
      `// sees none: cache.inputs.${probe.field} keys them.`,
      `export const ${probe.name} = ${quote(probe.command)}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
