// moon → vx mapping, the pure half. Reads `.moon/workspace.yml` (which
// directories are projects), the inherited task files (`.moon/tasks.yml`
// and `.moon/tasks/**`) and each project's `moon.yml`, and emits one
// TaskConfig-shaped object per (project, task). Two consumers, one mapper:
// `moon()` hands the tasks to the `project` stage live, and
// `bunx @vzn/vx-migrate --from moon` renders them to vx.config.ts files.
//
// moon's rules followed here, from its docs and its own repos
// (moonrepo/moon, moonrepo/examples, 2026-09-28):
// - a task file is inherited by name in moon 1 (`node.yml`,
//   `typescript-library.yml`, `tag-<t>.yml`) and by its `inheritedBy`
//   block in moon 2 (a workspace with `.moon/toolchains.yml`), where a file
//   without one is inherited by every project;
// - a project's task of the same name merges onto the inherited one field
//   by field (`options.merge*`: args, deps, env, inputs and outputs
//   append by default), and `workspace.inheritedTasks` include / exclude /
//   rename filter what it inherits;
// - a task with no `inputs` hashes every project file, and
//   `implicitInputs` / `implicitDeps` join every task;
// - `local: true` (moon 1) and `preset: server` are persistent and
//   uncached; `options.cache: false` is uncached;
// - a task runs from its project's directory with the workspace's whole
//   environment; vx's is isolated, so `$VAR` inputs are passed through.

import path from 'node:path'
import { pruneOrphanPersistentNotes, UserError, type ProjectMeta } from '@vzn/vx'
import { minimatchToVx } from '../glob-grammar.js'
import { shellQuote } from '../nx-command.js'
import { packageScripts, relPosix } from '../paths.js'
import { pruneDanglingEdges } from '../dangling-edges.js'
import { resolveSharedOutputs, resolveSharedWorkspaceOutputs } from '../shared-outputs.js'
import { DOTENV_PROBE } from '../dotenv-probe.js'

type Raw = Record<string, unknown>

export interface MoonMappedTask {
  name: string
  /** What did not map, in the words the migration report prints. */
  todos: string[]
  /** TaskConfig-shaped; null when the task has no vx form (the todos say why). */
  task: Record<string, unknown> | null
}

export interface MoonMappedProject {
  name: string
  dir: string
  tasks: MoonMappedTask[]
}

export interface MoonMapping {
  projects: MoonMappedProject[]
  /** Report lines about what the workspace holds that vx has no place for. */
  notes: string[]
}

export interface MapMoonOptions {
  /** The TODO attached to a persistent task, in the consumer's words. */
  persistentTodo: string
}

const YML = ['yml', 'yaml'] as const

/** `<dir>/<base>.yml`, else `.yaml`, else null. */
async function ymlFile(dir: string, base: string): Promise<string | null> {
  for (const ext of YML) {
    const file = path.join(dir, `${base}.${ext}`)
    if (await Bun.file(file).exists()) return file
  }
  return null
}

/** The workspace file that makes a directory a moon workspace, or null. */
export function moonWorkspaceFile(root: string): Promise<string | null> {
  return ymlFile(path.join(root, '.moon'), 'workspace')
}

/**
 * Every file the mapping reads, in a stable order: the plugin's cache key
 * is their paths and bytes. A project's `tsconfig.json` is read for its
 * existence only (it decides the inferred language).
 */
export async function moonReadList(root: string, metas: readonly ProjectMeta[]): Promise<string[]> {
  const moonDir = path.join(root, '.moon')
  const files: string[] = []
  for (const base of ['workspace', 'toolchain', 'toolchains', 'tasks']) {
    for (const ext of YML) files.push(path.join(moonDir, `${base}.${ext}`))
  }
  files.push(...(await taskFiles(moonDir)))
  for (const m of metas) {
    for (const ext of YML) files.push(path.join(m.dir, `moon.${ext}`))
    files.push(path.join(m.dir, 'tsconfig.json'))
  }
  return files
}

/** `.moon/tasks/**` task files, sorted. */
async function taskFiles(moonDir: string): Promise<string[]> {
  const dir = path.join(moonDir, 'tasks')
  const out: string[] = []
  try {
    for await (const f of new Bun.Glob('**/*.{yml,yaml}').scan({ cwd: dir, dot: true })) {
      out.push(path.join(dir, f))
    }
  } catch {
    // No `.moon/tasks` directory: nothing inherited from it.
  }
  return out.sort()
}

async function readYaml(file: string, root: string): Promise<Raw> {
  const text = await Bun.file(file).text()
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${relPosix(root, file)}: ${msg}`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError(`${relPosix(root, file)} is not a YAML mapping`)
  }
  return parsed as Raw
}

async function readOptionalYaml(file: string | null, root: string): Promise<Raw> {
  return file === null ? {} : readYaml(file, root)
}

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)]

/** A project directory relative to the root, normalized: `packages/a`. */
function normDir(p: string): string {
  return path.posix.normalize(p.replace(/^\.\//, '')).replace(/\/$/, '')
}

interface MoonProject {
  id: string
  meta: ProjectMeta
  file: Raw
}

/**
 * The workspace's projects that vx discovered too: `projects` as a map of
 * id → directory, a list of globs, or `{ globs, sources }`. A glob project's
 * id is its directory name unless its `moon.yml` names one.
 */
async function moonProjects(
  root: string,
  workspace: Raw,
  metas: readonly ProjectMeta[],
  notes: string[],
): Promise<MoonProject[]> {
  const raw = workspace['projects']
  const sources = new Map<string, string>()
  const globs: string[] = []
  if (Array.isArray(raw)) globs.push(...strings(raw))
  else if (isRaw(raw)) {
    const hasShape = 'globs' in raw || 'sources' in raw
    const map = hasShape ? raw['sources'] : raw
    if (isRaw(map)) {
      for (const [id, dir] of Object.entries(map)) {
        if (typeof dir === 'string') sources.set(normDir(dir), id)
      }
    }
    if (hasShape) globs.push(...strings(raw['globs']))
  }
  const positive = globs.filter((g) => !g.startsWith('!')).map((g) => new Bun.Glob(normDir(g)))
  const negative = globs
    .filter((g) => g.startsWith('!'))
    .map((g) => new Bun.Glob(normDir(g.slice(1))))

  const out: MoonProject[] = []
  const seen = new Set<string>()
  for (const meta of metas) {
    const rel = normDir(relPosix(root, meta.dir))
    if (rel === '.' || rel === '') continue
    let id = sources.get(rel)
    const globbed =
      id === undefined && positive.some((g) => g.match(rel)) && !negative.some((g) => g.match(rel))
    if (id === undefined && !globbed) continue
    const file = await readOptionalYaml(await ymlFile(meta.dir, 'moon'), root)
    if (id === undefined)
      id = typeof file['id'] === 'string' ? file['id'] : path.posix.basename(rel)
    out.push({ id, meta, file })
    seen.add(rel)
  }
  for (const [dir, id] of sources) {
    if (dir === '.' || seen.has(dir)) continue
    notes.push(
      `note: moon project ${id} (${dir}) is not a workspace package — vx discovers projects ` +
        'from the package manager; its tasks are not mapped',
    )
  }
  return out
}

interface TaskFile {
  file: string
  raw: Raw
}

/** The facts inheritance is decided on, as moon infers them for a JS package. */
interface Facts {
  language: string
  layer: string | null
  platform: string
  toolchains: Set<string>
  tags: string[]
  stack: string | null
}

async function factsOf(p: MoonProject, configured: ReadonlySet<string>): Promise<Facts> {
  const f = p.file
  const hasTsconfig = await Bun.file(path.join(p.meta.dir, 'tsconfig.json')).exists()
  const language =
    typeof f['language'] === 'string' ? f['language'] : hasTsconfig ? 'typescript' : 'javascript'
  const layerRaw = f['layer'] ?? f['type']
  const platform = typeof f['platform'] === 'string' ? f['platform'] : 'node'
  const toolchains = new Set<string>(['javascript'])
  for (const t of ['node', 'bun', 'deno']) if (configured.has(t)) toolchains.add(t)
  if (configured.size === 0) toolchains.add('node')
  if (language === 'typescript') toolchains.add('typescript')
  const declared = f['toolchains'] ?? f['toolchain']
  if (isRaw(declared)) {
    if (typeof declared['default'] === 'string') toolchains.add(declared['default'])
    for (const k of Object.keys(declared)) if (k !== 'default') toolchains.add(k)
  } else for (const t of strings(declared)) toolchains.add(t)
  return {
    language,
    layer: typeof layerRaw === 'string' ? layerRaw : null,
    platform,
    toolchains,
    tags: strings(f['tags']),
    stack: typeof f['stack'] === 'string' ? f['stack'] : null,
  }
}

const INHERITED_BY: Readonly<Record<string, (facts: Facts) => readonly string[]>> = {
  toolchain: (f) => [...f.toolchains],
  toolchains: (f) => [...f.toolchains],
  language: (f) => [f.language],
  languages: (f) => [f.language],
  layer: (f) => (f.layer === null ? [] : [f.layer]),
  layers: (f) => (f.layer === null ? [] : [f.layer]),
  stack: (f) => (f.stack === null ? [] : [f.stack]),
  stacks: (f) => (f.stack === null ? [] : [f.stack]),
  tag: (f) => f.tags,
  tags: (f) => f.tags,
}

/** One `inheritedBy` condition: a name, a list (any), or `{ and, or, not }`. */
function conditionHolds(value: unknown, have: readonly string[]): boolean {
  if (isRaw(value)) {
    const and = strings(value['and'])
    const or = strings(value['or'])
    const not = strings(value['not'])
    return (
      and.every((v) => have.includes(v)) &&
      (or.length === 0 || or.some((v) => have.includes(v))) &&
      !not.some((v) => have.includes(v))
    )
  }
  return strings(value).some((v) => have.includes(v))
}

/**
 * The task files a project inherits, in merge order. moon 2 (`v2`) decides
 * by each file's `inheritedBy` (none: every project), sorted by its
 * `order`; moon 1 by the file's name against the project's platform,
 * language, type and tags. A condition this mapper does not know keeps the
 * file out, with a note: a task missing is visible, one wrongly present is not.
 */
function inheritedFiles(
  files: readonly TaskFile[],
  facts: Facts,
  v2: boolean,
  unknownKeys: Set<string>,
): TaskFile[] {
  if (v2) {
    const picked = files.filter(({ raw }) => {
      const by = raw['inheritedBy']
      if (!isRaw(by)) return true
      return Object.entries(by).every(([k, v]) => {
        if (k === 'order') return true
        const have = INHERITED_BY[k]
        if (have === undefined) {
          unknownKeys.add(k)
          return false
        }
        return conditionHolds(v, have(facts))
      })
    })
    const order = (t: TaskFile): number => {
      const by = t.raw['inheritedBy']
      return isRaw(by) && typeof by['order'] === 'number' ? by['order'] : 0
    }
    return picked
      .map((t, i) => ({ t, i }))
      .sort((a, b) => order(a.t) - order(b.t) || a.i - b.i)
      .map((x) => x.t)
  }
  const names: string[] = [facts.platform, facts.language]
  if (facts.layer !== null)
    names.push(`${facts.platform}-${facts.layer}`, `${facts.language}-${facts.layer}`)
  for (const tag of facts.tags) names.push(`tag-${tag}`)
  const byName = new Map(files.map((t) => [path.basename(t.file).replace(/\.ya?ml$/, ''), t]))
  return uniq(names).flatMap((n) => (byName.has(n) ? [byName.get(n)!] : []))
}

const MERGEABLE = ['args', 'deps', 'env', 'inputs', 'outputs'] as const
type Mergeable = (typeof MERGEABLE)[number]
const MERGE_OPTION: Record<Mergeable, string> = {
  args: 'mergeArgs',
  deps: 'mergeDeps',
  env: 'mergeEnv',
  inputs: 'mergeInputs',
  outputs: 'mergeOutputs',
}

/**
 * A command-line word: from a YAML list it is one argv entry and is quoted;
 * from a string it is shell text and goes in as written.
 */
interface Word {
  text: string
  quote: boolean
}

/** Shell text as words: split on blanks unless it holds quoting or operators, then kept whole. */
function shellWords(text: string): Word[] {
  const t = text.trim()
  if (t === '') return []
  if (/[|&;<>()`"'\\]/.test(t)) return [{ text: t, quote: false }]
  return t.split(/\s+/).map((w) => ({ text: w, quote: false }))
}

function wordsOf(v: unknown): Word[] {
  if (typeof v === 'string') return shellWords(v)
  return strings(v).map((text) => ({ text, quote: true }))
}

/**
 * One layer as moon reads it: a `command` is its first word, and the rest
 * joins the layer's `args` ahead of them (`[tsc, --build]` is `tsc` with
 * args `[--build]`), so a later layer's args merge after them.
 */
function normLayer(t: Raw): Raw {
  const out: Raw = { ...t }
  if (t['command'] !== undefined && t['command'] !== null) {
    const words = wordsOf(t['command'])
    out['command'] = words[0] ?? null
    const args = [...words.slice(1), ...wordsOf(t['args'])]
    if (args.length > 0 || t['args'] !== undefined) out['args'] = args
    else delete out['args']
  } else if (t['args'] !== undefined) out['args'] = wordsOf(t['args'])
  return out
}

/**
 * A task's layers folded in order, as moon merges them: each field the
 * later layer sets replaces the earlier one, except the mergeable lists,
 * which follow the strategy the task's FINAL options name (moon merges the
 * options of every layer first: a project's `mergeArgs: prepend` puts its
 * args ahead of every inherited layer's, probed on moon 2.5).
 */
function fold(layers: readonly Raw[]): Raw {
  const options: Raw = Object.assign(
    {},
    ...layers.map((l) => (isRaw(l['options']) ? l['options'] : {})),
  )
  let out: Raw = {}
  for (const layer of layers) {
    const next: Raw = { ...out, ...layer }
    for (const field of MERGEABLE) {
      if (!(field in layer)) {
        if (field in out) next[field] = out[field]
        continue
      }
      // A layer that sets `command` sets its args with it: the earlier
      // command's args go (leonardo: an inferred `pnpm run test` under a
      // declared `[node, --test, …]` is `node --test …`, moon 1.41).
      const strategy =
        field === 'args' && layer['command'] !== undefined && layer['command'] !== null
          ? 'replace'
          : (options[MERGE_OPTION[field]] ?? options['merge'] ?? 'append')
      const a = out[field]
      const b = layer[field]
      if (a === undefined || strategy === 'replace') next[field] = b
      else if (strategy === 'preserve') next[field] = a
      else if (field === 'env' && isRaw(a) && isRaw(b)) {
        next[field] = strategy === 'prepend' ? { ...b, ...a } : { ...a, ...b }
      } else {
        next[field] =
          strategy === 'prepend' ? [...listOf(b), ...listOf(a)] : [...listOf(a), ...listOf(b)]
      }
    }
    out = next
  }
  out['options'] = options
  return out
}

function listOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v === undefined || v === null) return []
  return [v]
}

/**
 * Every task of a project: the inherited files' tasks (filtered and renamed
 * by `workspace.inheritedTasks`), the project's own layer on top, each
 * folded, then each `extends` resolved against the project's tasks.
 */
function projectTasks(
  p: MoonProject,
  global: Raw,
  inherited: readonly TaskFile[],
  inferred: ReadonlyMap<string, Raw>,
): {
  tasks: Map<string, Raw>
  groups: Map<string, string[]>
  implicitDeps: string[]
  implicitInputs: string[]
} {
  const groups = new Map<string, string[]>()
  const implicitDeps: string[] = []
  const implicitInputs: string[] = []
  const fromFiles = new Map<string, Raw[]>()
  for (const raw of [global, ...inherited.map((t) => t.raw)]) {
    if (isRaw(raw['fileGroups'])) {
      for (const [g, v] of Object.entries(raw['fileGroups'])) groups.set(g, strings(v))
    }
    implicitDeps.push(...strings(raw['implicitDeps']))
    implicitInputs.push(...strings(raw['implicitInputs']))
    const taskOptions = isRaw(raw['taskOptions']) ? raw['taskOptions'] : {}
    if (!isRaw(raw['tasks'])) continue
    for (const [name, t] of Object.entries(raw['tasks'])) {
      if (!isRaw(t)) continue
      const layer = normLayer({
        ...t,
        options: { ...taskOptions, ...(isRaw(t['options']) ? t['options'] : {}) },
      })
      fromFiles.set(name, [...(fromFiles.get(name) ?? []), layer])
    }
  }

  const ws = isRaw(p.file['workspace']) ? p.file['workspace'] : {}
  const it = isRaw(ws['inheritedTasks']) ? ws['inheritedTasks'] : {}
  const include = Array.isArray(it['include']) ? new Set(strings(it['include'])) : null
  const exclude = new Set(strings(it['exclude']))
  const rename = isRaw(it['rename']) ? it['rename'] : {}

  const layers = new Map<string, Raw[]>()
  for (const [name, ls] of fromFiles) {
    if (include !== null && !include.has(name)) continue
    if (exclude.has(name)) continue
    layers.set(typeof rename[name] === 'string' ? (rename[name] as string) : name, ls)
  }
  if (isRaw(p.file['fileGroups'])) {
    for (const [g, v] of Object.entries(p.file['fileGroups'])) groups.set(g, strings(v))
  }
  // A task inferred from a package.json script is the project's own, and
  // its moon.yml declaration of the same name merges over it.
  for (const [name, t] of inferred) layers.set(name, [...(layers.get(name) ?? []), normLayer(t)])
  if (isRaw(p.file['tasks'])) {
    for (const [name, t] of Object.entries(p.file['tasks'])) {
      if (isRaw(t)) layers.set(name, [...(layers.get(name) ?? []), normLayer(t)])
    }
  }
  // `extends: <task>`: this task is the named one with its own layers folded on.
  const tasks = new Map<string, Raw>()
  const resolving = new Set<string>()
  const resolve = (name: string): Raw | undefined => {
    const done = tasks.get(name)
    if (done !== undefined) return done
    const ls = layers.get(name)
    if (ls === undefined) return undefined
    const base = ls.map((l) => l['extends']).findLast((e) => typeof e === 'string')
    if (resolving.has(name)) throw new UserError(`moon task ${p.id}:${name} extends form a cycle`)
    resolving.add(name)
    const parent = typeof base === 'string' ? resolve(base) : undefined
    resolving.delete(name)
    const def = fold(parent === undefined ? ls : [parent, ...ls])
    delete def['extends']
    tasks.set(name, def)
    return def
  }
  for (const name of layers.keys()) resolve(name)
  return { tasks, groups, implicitDeps, implicitInputs }
}

const ENV_FILE_TODO =
  "options.envFile: moon loads the file into the task's environment and vx does not — the " +
  'file is keyed; pass its variables with exec.env.passThrough or load it in the command'

/** Options whose meaning vx has no per-task form for; named in a todo when set. */
const UNMAPPED_OPTIONS = new Set([
  'affectedFiles',
  'envFile',
  'interactive',
  'mutex',
  'os',
  'runDepsInParallel',
  'unixShell',
  'windowsShell',
])

/** The facts every task of one project maps against. */
interface Ctx {
  root: string
  project: MoonProject
  rel: string
  groups: ReadonlyMap<string, string[]>
  /** Moon id or package name → package name, for `project:task` deps. */
  names: ReadonlyMap<string, string>
  /** Package name → the task names it emits. */
  emitted: ReadonlyMap<string, ReadonlySet<string>>
  emittedAnywhere: ReadonlySet<string>
  /**
   * Packages the project's `moon.yml` `dependsOn` names that its package.json
   * does not: moon's `^` reaches them, vx's `^` follows the package graph.
   */
  moonOnlyDeps: readonly string[]
  /** moon 2's rules, where they differ from moon 1's. */
  v2: boolean
  opts: MapMoonOptions
}

/**
 * A project-relative path in vx's terms: `{ ws: false, path }` inside the
 * project, `{ ws: true, path }` workspace-relative (a moon `/` prefix, or
 * a `../` that climbs out), or null when it leaves the workspace.
 */
function place(ctx: Ctx, p: string): { ws: boolean; path: string } | null {
  let s = p.replace(/^\$projectRoot\//, '').replace(/^\.\//, '')
  if (s.startsWith('$workspaceRoot/')) return { ws: true, path: s.slice('$workspaceRoot/'.length) }
  if (s.startsWith('/')) return { ws: true, path: s.replace(/^\/+/, '') }
  if (!s.startsWith('../')) return { ws: false, path: s }
  s = path.posix.normalize(path.posix.join(ctx.rel, s))
  return s.startsWith('../') ? null : { ws: true, path: s }
}

/** A group reference's entries (`@group(name)`, `@globs`, `@files`, `@dirs`); null for any other token. */
function groupRef(ctx: Ctx, entry: string): string[] | null {
  const m = /^@(group|globs|files|dirs)\(([^)]+)\)$/.exec(entry)
  if (m === null) return null
  const entries = ctx.groups.get(m[2]!) ?? []
  // `@globs` is the group's globs, `@files` and `@dirs` its paths.
  const isGlob = (e: string): boolean => /[*?{[]/.test(e)
  if (m[1] === 'globs') return entries.filter(isGlob)
  if (m[1] === 'files' || m[1] === 'dirs') return entries.filter((e) => !isGlob(e))
  return entries
}

function mapInputs(
  ctx: Ctx,
  def: Raw,
  implicit: readonly string[],
  todos: string[],
): { files: string[]; ws: string[]; env: string[]; dotenv: boolean; wsDotenv: boolean } {
  let dotenv = false
  let wsDotenv = false
  const files: string[] = []
  const ws: string[] = []
  const env: string[] = []
  const set = Object.hasOwn(def, 'inputs') && def['inputs'] !== null
  // moon's default input set is every project file.
  if (!set) files.push('**/*')
  const add = (entry: string): void => {
    const neg = entry.startsWith('!')
    const body = neg ? entry.slice(1) : entry
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) {
      env.push(entry.slice(1))
      return
    }
    if (entry.startsWith('$') && !/^\$(projectRoot|workspaceRoot)\//.test(entry)) {
      todos.push(
        `input ${JSON.stringify(entry)}: a wildcard or token vx has no form for — list explicit env names in cache.inputs.env`,
      )
      return
    }
    const group = groupRef(ctx, body)
    if (group !== null) {
      for (const g of group) add(neg ? `!${g}` : g)
      return
    }
    if (body.startsWith('@')) {
      todos.push(
        `input ${JSON.stringify(entry)}: token vx has no form for — every project file is keyed`,
      )
      if (!neg) files.push('**/*')
      return
    }
    const uri = /^(file|glob):\/\/(.*)$/.exec(body)
    const plain = uri === null ? body : uri[2]!
    const last = plain.slice(plain.lastIndexOf('/') + 1)
    const at = place(ctx, plain)
    if (at !== null && !neg && (last.startsWith('.env') || last.endsWith('.env'))) {
      if (at.ws) wsDotenv = true
      else dotenv = true
      return
    }
    if (at === null) {
      todos.push(`input ${JSON.stringify(entry)}: leaves the workspace — map manually`)
      return
    }
    const glob = minimatchToVx(at.path, neg)
    if (glob === null) {
      todos.push(
        `input ${JSON.stringify(entry)}: glob syntax vx cannot take — every project file is keyed`,
      )
      if (!neg) files.push('**/*')
      return
    }
    ;(at.ws ? ws : files).push((neg ? '!' : '') + glob)
  }
  for (const i of listOf(def['inputs'])) {
    if (typeof i === 'string') add(i)
    else if (isRaw(i) && (typeof i['file'] === 'string' || typeof i['glob'] === 'string')) {
      add((i['file'] ?? i['glob']) as string)
    } else {
      todos.push(
        `input ${JSON.stringify(i)}: a form vx has no mapping for — every project file is keyed`,
      )
      files.push('**/*')
    }
  }
  for (const i of implicit) add(i)
  // Exclusions alone would narrow nothing, and core refuses that list.
  if (files.length > 0 && files.every((f) => f.startsWith('!'))) files.unshift('**/*')
  if (ws.length > 0 && ws.every((f) => f.startsWith('!'))) ws.length = 0
  // `envFile` names a project `.env` (`true`) or a path; either is keyed by the probe.
  const envFile = isRaw(def['options']) ? def['options']['envFile'] : undefined
  if (envFile === true) dotenv = true
  else if (typeof envFile === 'string') {
    if (place(ctx, envFile)?.ws === true) wsDotenv = true
    else dotenv = true
  }
  return { files: uniq(files), ws: uniq(ws), env: uniq(env), dotenv, wsDotenv }
}

/**
 * The outputs, or null when the task must run uncached (a todo says why):
 * a negation or a wildcard first segment would have vx clean the sources.
 */
function mapOutputs(ctx: Ctx, def: Raw, todos: string[]): { files: string[]; ws: string[] } | null {
  const files: string[] = []
  const ws: string[] = []
  for (const o of listOf(def['outputs'])) {
    const raw = typeof o === 'string' ? o : isRaw(o) ? (o['file'] ?? o['glob']) : undefined
    if (typeof raw !== 'string') {
      todos.push(`output ${JSON.stringify(o)}: a form vx has no mapping for — task runs uncached`)
      return null
    }
    const expanded = groupRef(ctx, raw) ?? [raw]
    for (const e of expanded) {
      const uri = /^(file|glob):\/\/(.*)$/.exec(e)
      const s = uri === null ? e : uri[2]!
      if (s.startsWith('!') || s.startsWith('@') || s.startsWith('$')) {
        todos.push(
          `output ${JSON.stringify(e)}: vx outputs have no negation or token — task runs uncached; declare the exact outputs in a vx.config to cache it`,
        )
        return null
      }
      const at = place(ctx, s)
      if (at === null) {
        todos.push(`output ${JSON.stringify(e)}: leaves the workspace — task runs uncached`)
        return null
      }
      const first = at.path.split('/')[0] ?? ''
      const glob = minimatchToVx(at.path, false)
      if (glob === null || /[*?{[]/.test(first)) {
        todos.push(
          `output ${JSON.stringify(e)}: a wildcard first segment or glob syntax vx cannot take ` +
            'reaches the sources, which vx cleans before every run — task runs uncached; ' +
            'declare the exact outputs in a vx.config to cache it',
        )
        return null
      }
      ;(at.ws ? ws : files).push(glob)
    }
  }
  return { files: uniq(files), ws: uniq(ws) }
}

/** moon's command tokens in a word, or null when one has no vx form. */
function expandTokens(ctx: Ctx, def: Raw, name: string, word: string): string | null {
  const nth = (list: unknown, i: number): string | null => {
    const raw = listOf(list)[i]
    const e = isRaw(raw) ? (raw['file'] ?? raw['glob']) : raw
    if (typeof e !== 'string') return null
    const at = place(ctx, e)
    if (at === null) return null
    return at.ws ? relPosix(ctx.project.meta.dir, path.join(ctx.root, at.path)) || '.' : at.path
  }
  let bad = false
  const out = word
    .replace(/@(in|out)\((\d+)\)/g, (_, kind: string, n: string) => {
      const v = nth(def[kind === 'in' ? 'inputs' : 'outputs'], Number(n))
      if (v === null) bad = true
      return v ?? ''
    })
    .replace(
      /\$(workspaceRoot|projectRoot|projectSource|project|target|task)\b/g,
      (_, v: string) => {
        if (v === 'workspaceRoot') return relPosix(ctx.project.meta.dir, ctx.root) || '.'
        if (v === 'projectRoot') return '.'
        if (v === 'projectSource') return ctx.rel
        if (v === 'project') return ctx.project.id
        if (v === 'task') return name
        return `${ctx.project.id}:${name}`
      },
    )
  if (bad || /@\w+\(/.test(out)) return null
  return out
}

/** The sh line: `command` + `args`, or `script`; undefined for a no-op, null for a token vx lacks. */
function commandLine(ctx: Ctx, def: Raw, name: string, todos: string[]): string | null | undefined {
  const script = def['script']
  if (typeof script === 'string') return expandTokens(ctx, def, name, script) ?? badToken(todos)
  const command = def['command'] as Word | null | undefined
  if (command === undefined || command === null) return undefined
  if (['noop', 'nop', 'no-op'].includes(command.text)) return undefined
  const words: string[] = []
  for (const w of [command, ...(listOf(def['args']) as Word[])]) {
    const x = expandTokens(ctx, def, name, w.text)
    if (x === null) return badToken(todos)
    words.push(!w.quote || /^[\w@%+=:,./-]+$/.test(x) ? x : shellQuote(x))
  }
  return words.join(' ')
}

function badToken(todos: string[]): null {
  todos.push(
    'the command uses a moon token vx has no form for — task skipped; write the command by hand',
  )
  return null
}

function mapTask(
  ctx: Ctx,
  name: string,
  def: Raw,
  implicitInputs: readonly string[],
  implicitDeps: readonly string[],
): MoonMappedTask {
  const todos: string[] = []
  const options = isRaw(def['options']) ? def['options'] : {}
  const command = commandLine(ctx, def, name, todos)
  if (command === null) return { name, todos, task: null }
  for (const k of Object.keys(options)) {
    if (UNMAPPED_OPTIONS.has(k) && options[k] !== false && options[k] !== undefined) {
      todos.push(
        k === 'envFile'
          ? ENV_FILE_TODO
          : `options.${k} (${JSON.stringify(options[k])}) has no vx equivalent — map it manually`,
      )
    }
  }
  const preset = def['preset']
  // moon 1 makes a task named dev, start or serve `local` unless it says
  // otherwise (leonardo's inferred `start`, jsx-email's `dev`).
  const local =
    def['local'] === true || (!ctx.v2 && def['local'] === undefined && LOCAL_NAMES.has(name))
  const persistent =
    options['persistent'] === true ||
    (options['persistent'] !== false && local) ||
    preset === 'server' ||
    preset === 'watcher'

  const deps: string[] = []
  const edge = (d: string): void => {
    if (!deps.includes(d)) deps.push(d)
  }
  for (const raw of [...listOf(def['deps']), ...implicitDeps]) {
    const target =
      typeof raw === 'string'
        ? raw
        : isRaw(raw) && typeof raw['target'] === 'string'
          ? raw['target']
          : null
    if (target === null) {
      todos.push(`dep ${JSON.stringify(raw)}: a form vx has no mapping for — edge dropped`)
      continue
    }
    if (isRaw(raw) && (raw['args'] !== undefined || raw['env'] !== undefined)) {
      todos.push(
        `dep ${JSON.stringify(target)} passes args or env — vx runs the dependency as declared`,
      )
    }
    const colon = target.lastIndexOf(':')
    const scope = colon === -1 ? '~' : target.slice(0, colon)
    const task = colon === -1 ? target : target.slice(colon + 1)
    if (task === name && scope === '~') continue
    if (scope === '~' || scope === '') {
      if (scope === '' && colon !== -1) {
        todos.push(
          `dep ${JSON.stringify(target)}: every project's task — vx has no all-projects edge; edge dropped`,
        )
      } else if (ctx.emitted.get(ctx.project.meta.name)?.has(task)) edge(task)
      else todos.push(`dep ${JSON.stringify(target)}: the project has no such task — edge dropped`)
    } else if (scope === '^') {
      if (ctx.emittedAnywhere.has(task)) edge(`^${task}`)
      for (const pkg of ctx.moonOnlyDeps)
        if (ctx.emitted.get(pkg)?.has(task)) edge(`${pkg}#${task}`)
    } else if (scope.startsWith('#')) {
      todos.push(`dep ${JSON.stringify(target)}: tag targets have no vx form — edge dropped`)
    } else {
      const pkg = ctx.names.get(scope)
      if (pkg !== undefined && ctx.emitted.get(pkg)?.has(task)) {
        edge(pkg === ctx.project.meta.name ? task : `${pkg}#${task}`)
      } else
        todos.push(
          `dep ${JSON.stringify(target)}: no workspace package runs that task — edge dropped`,
        )
    }
  }

  const inputs = mapInputs(ctx, def, implicitInputs, todos)
  const define: Record<string, string> = {}
  if (isRaw(def['env'])) {
    for (const [k, v] of Object.entries(def['env'])) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        define[k] = String(v)
    }
  }

  const task: Record<string, unknown> = {}
  if (command !== undefined) {
    const cd =
      options['runFromWorkspaceRoot'] === true ? relPosix(ctx.project.meta.dir, ctx.root) : ''
    const exec: Record<string, unknown> = {
      command: cd === '' ? command : `cd ${cd} && ${command}`,
    }
    const env: Record<string, unknown> = {}
    if (inputs.env.length > 0) env['passThrough'] = inputs.env
    if (Object.keys(define).length > 0) env['define'] = define
    if (Object.keys(env).length > 0) exec['env'] = env
    if (typeof options['retryCount'] === 'number' && options['retryCount'] > 0) {
      exec['retries'] = options['retryCount']
    }
    if (typeof options['timeout'] === 'number' && options['timeout'] > 0) {
      exec['timeout'] = Math.min(options['timeout'] * 1000, 2147483647)
    }
    if (persistent) {
      exec['persistent'] = {}
      todos.push(ctx.opts.persistentTodo)
    }
    task['exec'] = exec
  }
  if (deps.length > 0) task['dependsOn'] = deps
  if (command === undefined && deps.length === 0) {
    todos.push('a no-op task with no deps — nothing to run')
    return { name, todos, task: null }
  }

  const cacheable =
    !(local && options['cache'] === undefined) &&
    command !== undefined &&
    !persistent &&
    options['cache'] !== false &&
    options['cache'] !== 'off'
  if (cacheable) {
    const outputs = mapOutputs(ctx, def, todos)
    if (outputs !== null) {
      const cacheInputs: Record<string, unknown> = { files: inputs.files }
      if (inputs.ws.length > 0) cacheInputs['workspaceFiles'] = inputs.ws
      if (inputs.env.length > 0) cacheInputs['env'] = inputs.env
      if (inputs.dotenv) cacheInputs['runtime'] = [DOTENV_PROBE]
      if (inputs.wsDotenv) cacheInputs['workspaceRuntime'] = [DOTENV_PROBE]
      const cacheOutputs: Record<string, unknown> = { files: outputs.files }
      if (outputs.ws.length > 0) cacheOutputs['workspaceFiles'] = outputs.ws
      task['cache'] = { inputs: cacheInputs, outputs: cacheOutputs }
    }
  }
  return { name, todos, task }
}

export async function mapMoonWorkspace(
  root: string,
  metas: readonly ProjectMeta[],
  opts: MapMoonOptions,
): Promise<MoonMapping> {
  const moonDir = path.join(root, '.moon')
  const wsFile = await moonWorkspaceFile(root)
  if (wsFile === null) throw new UserError('no .moon/workspace.yml at the workspace root')
  const notes: string[] = []
  const workspace = await readYaml(wsFile, root)
  const v2File = await ymlFile(moonDir, 'toolchains')
  const v2 = v2File !== null
  const toolchain = await readOptionalYaml(v2File ?? (await ymlFile(moonDir, 'toolchain')), root)
  const configured = new Set(Object.keys(toolchain).filter((k) => !k.startsWith('$')))
  const global = await readOptionalYaml(await ymlFile(moonDir, 'tasks'), root)
  const files: TaskFile[] = []
  for (const file of await taskFiles(moonDir)) files.push({ file, raw: await readYaml(file, root) })

  const projects = await moonProjects(root, workspace, metas, notes)
  const names = new Map<string, string>()
  for (const p of projects) {
    names.set(p.id, p.meta.name)
    names.set(p.meta.name, p.meta.name)
  }
  const node = isRaw(toolchain['node']) ? toolchain['node'] : {}
  const inferScripts = node['inferTasksFromScripts'] === true
  const packageManager = typeof node['packageManager'] === 'string' ? node['packageManager'] : 'npm'
  const unknownKeys = new Set<string>()
  const resolved = await Promise.all(
    projects.map(async (p) => {
      const facts = await factsOf(p, configured)
      const inferred = inferScripts ? scriptTasks(p.meta, packageManager) : new Map<string, Raw>()
      return {
        p,
        ...projectTasks(p, global, inheritedFiles(files, facts, v2, unknownKeys), inferred),
      }
    }),
  )
  for (const k of unknownKeys) {
    notes.push(
      `note: task files with inheritedBy.${k} are not inherited — vx-migrate does not know that condition; declare their tasks in a vx.config`,
    )
  }
  const remote = isRaw(workspace['remote']) ? workspace['remote']['host'] : undefined
  if (typeof remote === 'string') {
    notes.push(
      `note: moon's remote cache (${remote}) speaks Bazel REAPI — \`reapi()\` from @vzn/vx-reapi ` +
        'stores vx artifacts on the same server under vx keys',
    )
  }
  notes.push(
    'note: moon passes every environment variable to a task; vx passes only the declared ones — ' +
      'list what a task reads as a `$VAR` input or in exec.env.passThrough',
  )

  const emitted = new Map<string, Set<string>>()
  const emittedAnywhere = new Set<string>()
  for (const { p, tasks } of resolved) {
    emitted.set(p.meta.name, new Set(tasks.keys()))
    for (const t of tasks.keys()) emittedAnywhere.add(t)
  }

  const out: MoonMappedProject[] = []
  for (const { p, tasks, groups, implicitDeps, implicitInputs } of resolved) {
    const ctx: Ctx = {
      root,
      project: p,
      rel: normDir(relPosix(root, p.meta.dir)),
      groups,
      names,
      emitted,
      emittedAnywhere,
      moonOnlyDeps: moonOnlyDeps(p, names),
      v2,
      opts,
    }
    const mapped = [...tasks].map(([name, def]) =>
      mapTask(ctx, name, def, implicitInputs, implicitDeps),
    )
    out.push({ name: p.meta.name, dir: p.meta.dir, tasks: mapped })
  }
  pruneDanglingEdges(out)
  for (const p of out) resolveSharedOutputs(p.tasks)
  resolveSharedWorkspaceOutputs(root, out)
  pruneOrphanPersistentNotes(out, opts.persistentTodo)
  return { projects: out, notes }
}

const LOCAL_NAMES = new Set(['dev', 'start', 'serve'])

// npm's own lifecycle scripts, which moon does not turn into tasks.
const LIFECYCLE =
  /^(pre|post)?(install|publish|pack|version|prepare|prepublishOnly|uninstall|shrinkwrap)$/

/**
 * `node.inferTasksFromScripts` (moon 1): each package.json script is a
 * task running `<packageManager> run <script>`, its id the script name with
 * `:` as `-` (leonardo: `test:types` is `test-types`). A `pre`/`post` hook
 * runs inside its script's `run`, so it is no task of its own.
 */
function scriptTasks(meta: ProjectMeta, packageManager: string): Map<string, Raw> {
  const scripts = packageScripts(meta)
  const out = new Map<string, Raw>()
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string' || body === '' || LIFECYCLE.test(name)) continue
    const hook = /^(pre|post)(.+)$/.exec(name)
    if (hook !== null && Object.hasOwn(scripts, hook[2]!)) continue
    out.set(name.replaceAll(':', '-'), { command: [packageManager, 'run', name] })
  }
  return out
}

const PACKAGE_DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

function moonOnlyDeps(p: MoonProject, names: ReadonlyMap<string, string>): string[] {
  const pj = p.meta.packageJson as unknown as Raw
  const declared = new Set(
    PACKAGE_DEP_FIELDS.flatMap((f) => (isRaw(pj[f]) ? Object.keys(pj[f]) : [])),
  )
  const out: string[] = []
  for (const d of listOf(p.file['dependsOn'])) {
    const id = typeof d === 'string' ? d : isRaw(d) && typeof d['id'] === 'string' ? d['id'] : null
    const pkg = id === null ? undefined : names.get(id)
    if (pkg !== undefined && pkg !== p.meta.name && !declared.has(pkg)) out.push(pkg)
  }
  return uniq(out)
}
