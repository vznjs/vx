// wireit → vx mapping, the pure half. wireit keeps each script's config in
// its package.json (`wireit.<script>`: command, dependencies, files,
// output, env, service), so the mapping is per package with edges across
// them. Two consumers, one mapper: `wireit()` hands the tasks to the
// `project` stage live, and `bunx @vzn/vx-migrate --from wireit` renders
// them to vx.config.ts files.
//
// wireit's rules followed here (its README, 0.14.13; lit/lit, 2026-09-28):
// - a task is cached only when both `files` and `output` are set; either
//   missing means it always runs;
// - `output` is deleted before a run unless `clean: false`, as vx cleans;
//   under `clean: false` an output may be a file wireit never deletes
//   (spectacle's one-page example reads and writes its tracked
//   `index.html`), so such a task runs uncached;
// - a dependency is `script` in the package, or `<relative dir>:<script>`
//   (it starts with `.`), and one that is a plain npm script runs it;
// - `env` sets a value (a string) or names an external input
//   (`{ external: true }`);
// - `service` is long-running, ready on spawn or on `readyWhen.lineMatches`.

import path from 'node:path'
import { pruneOrphanPersistentNotes, type ProjectMeta } from '@vzn/vx'
import { minimatchToVx } from '../glob-grammar.js'
import { packageScripts, relPosix } from '../paths.js'
import { pruneDanglingEdges } from '../dangling-edges.js'
import { scriptCommand, yarnPnp } from '../script-command.js'
import { resolveSharedOutputs } from '../shared-outputs.js'

type Raw = Record<string, unknown>

export interface WireitMappedTask {
  name: string
  /** What did not map, in the words the migration report prints. */
  todos: string[]
  /** TaskConfig-shaped; null when the script has no vx form (the todos say why). */
  task: Record<string, unknown> | null
}

export interface WireitMappedProject {
  name: string
  dir: string
  tasks: WireitMappedTask[]
}

export interface WireitMapping {
  projects: WireitMappedProject[]
  /** Report lines about what the workspace holds that vx has no place for. */
  notes: string[]
}

export interface MapWireitOptions {
  /** The TODO attached to a persistent task, in the consumer's words. */
  persistentTodo: string
}

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)]

/** A package's `wireit` block, or `{}`. */
export function wireitOf(meta: ProjectMeta): Record<string, Raw> {
  const raw = (meta.packageJson as unknown as Raw)['wireit']
  if (!isRaw(raw)) return {}
  const out: Record<string, Raw> = {}
  for (const [k, v] of Object.entries(raw)) if (isRaw(v)) out[k] = v
  return out
}

/** A dependency as `[package dir, script, cascade]`, or null when it names none. */
function depTarget(
  dir: string,
  dep: unknown,
): { dir: string; script: string; cascade: boolean } | null {
  const spec = typeof dep === 'string' ? dep : isRaw(dep) ? dep['script'] : undefined
  if (typeof spec !== 'string' || spec === '') return null
  const cascade = !(isRaw(dep) && dep['cascade'] === false)
  if (!spec.startsWith('.')) return { dir, script: spec, cascade }
  const colon = spec.indexOf(':')
  if (colon === -1) return null
  return { dir: path.resolve(dir, spec.slice(0, colon)), script: spec.slice(colon + 1), cascade }
}

interface Ctx {
  root: string
  meta: ProjectMeta
  byDir: ReadonlyMap<string, ProjectMeta>
  /** Package name → the task names it emits. */
  emitted: ReadonlyMap<string, ReadonlySet<string>>
  opts: MapWireitOptions
}

/**
 * A `files` / `output` entry in vx's terms: inside the package, or
 * workspace-relative when `../` climbs out; null when it leaves the
 * workspace. wireit reads a leading `/` as the package.
 */
function place(ctx: Ctx, p: string): { ws: boolean; path: string } | null {
  const rel = relPosix(ctx.root, ctx.meta.dir)
  const s = p.replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!s.startsWith('../')) return { ws: false, path: s === '' ? '**' : s }
  const up = path.posix.normalize(path.posix.join(rel, s))
  return up.startsWith('../') ? null : { ws: true, path: up }
}

function mapWireitTask(ctx: Ctx, name: string, cfg: Raw): WireitMappedTask {
  const todos: string[] = []
  const command =
    typeof cfg['command'] === 'string' && cfg['command'] !== '' ? cfg['command'] : undefined
  const service = cfg['service']
  const persistent = service === true || isRaw(service)

  const deps: string[] = []
  for (const d of Array.isArray(cfg['dependencies']) ? cfg['dependencies'] : []) {
    const t = depTarget(ctx.meta.dir, d)
    if (t === null) {
      todos.push(`dependency ${JSON.stringify(d)}: not a script or <dir>:<script> — edge dropped`)
      continue
    }
    const target = ctx.byDir.get(t.dir)
    if (target === undefined) {
      todos.push(
        `dependency ${JSON.stringify(d)}: ${relPosix(ctx.root, t.dir) || '.'} is not a workspace package — edge dropped`,
      )
      continue
    }
    if (!ctx.emitted.get(target.name)?.has(t.script)) {
      todos.push(
        `dependency ${JSON.stringify(d)}: ${target.name} has no ${t.script} script — edge dropped`,
      )
      continue
    }
    if (!t.cascade) {
      todos.push(
        `dependency ${JSON.stringify(d)} has cascade: false — vx folds every dependency's key, ` +
          'so this task re-runs when that one changes',
      )
    }
    const id = target === ctx.meta ? t.script : `${target.name}#${t.script}`
    if (!deps.includes(id)) deps.push(id)
  }

  const define: Record<string, string> = {}
  const external: string[] = []
  if (isRaw(cfg['env'])) {
    for (const [k, v] of Object.entries(cfg['env'])) {
      if (typeof v === 'string') define[k] = v
      else if (isRaw(v) && v['external'] === true) {
        external.push(k)
        if (typeof v['default'] === 'string') {
          todos.push(
            `env ${k} has a default (${JSON.stringify(v['default'])}) — vx has none; the variable is ` +
              'passed through when set and absent otherwise',
          )
        }
      }
    }
  }
  if (cfg['allowUsuallyExcludedPaths'] === true) {
    todos.push('allowUsuallyExcludedPaths has no vx form — vx keys only files git lists')
  }

  const task: Record<string, unknown> = {}
  if (command !== undefined) {
    const exec: Record<string, unknown> = { command }
    const env: Record<string, unknown> = {}
    if (external.length > 0) env['passThrough'] = external
    if (Object.keys(define).length > 0) env['define'] = define
    if (Object.keys(env).length > 0) exec['env'] = env
    if (persistent) {
      const ready =
        isRaw(service) && isRaw(service['readyWhen'])
          ? service['readyWhen']['lineMatches']
          : undefined
      exec['persistent'] = typeof ready === 'string' ? { readyWhen: ready } : {}
      if (typeof ready !== 'string') todos.push(ctx.opts.persistentTodo)
    }
    task['exec'] = exec
  }
  if (deps.length > 0) task['dependsOn'] = deps
  if (command === undefined && deps.length === 0) {
    todos.push('no command and no dependencies — nothing to run')
    return { name, todos, task: null }
  }

  const files = cfg['files']
  const output = cfg['output']
  const cached =
    command !== undefined && !persistent && Array.isArray(files) && Array.isArray(output)
  if (cached && cfg['clean'] === false && strings(output).length > 0) {
    todos.push(
      "clean: false — wireit keeps this task's outputs and vx deletes them before every run, " +
        'which here may be a source file; task runs uncached',
    )
  } else if (cached) {
    const cache = mapCache(ctx, strings(files), strings(output), external, todos)
    if (cache !== null) task['cache'] = cache
  }
  return { name, todos, task }
}

function mapCache(
  ctx: Ctx,
  files: readonly string[],
  output: readonly string[],
  env: readonly string[],
  todos: string[],
): Raw | null {
  const inFiles: string[] = []
  const inWs: string[] = []
  for (const f of files) {
    const neg = f.startsWith('!')
    const at = place(ctx, neg ? f.slice(1) : f)
    if (at === null) {
      todos.push(`file ${JSON.stringify(f)}: leaves the workspace — map manually`)
      continue
    }
    const glob = minimatchToVx(at.path, neg)
    if (glob === null) {
      todos.push(
        `file ${JSON.stringify(f)}: glob syntax vx cannot take — every package file is keyed`,
      )
      if (!neg) inFiles.push('**/*')
      continue
    }
    ;(at.ws ? inWs : inFiles).push((neg ? '!' : '') + glob)
  }
  // Exclusions alone would narrow nothing, and core refuses that list.
  if (inFiles.length > 0 && inFiles.every((f) => f.startsWith('!'))) inFiles.unshift('**/*')
  if (inWs.length > 0 && inWs.every((f) => f.startsWith('!'))) inWs.length = 0

  const outFiles: string[] = []
  for (const o of output) {
    const at = o.startsWith('!') ? null : place(ctx, o)
    const glob = at === null || at.ws ? null : minimatchToVx(at.path, false)
    if (glob === null) {
      todos.push(
        `output ${JSON.stringify(o)}: a negation, a path outside the package or glob syntax vx ` +
          'cannot take — task runs uncached; declare the exact outputs in a vx.config to cache it',
      )
      return null
    }
    outFiles.push(glob)
  }
  const inputs: Raw = { files: uniq(inFiles) }
  if (inWs.length > 0) inputs['workspaceFiles'] = uniq(inWs)
  if (env.length > 0) inputs['env'] = [...env]
  return { inputs, outputs: { files: uniq(outFiles) } }
}

export async function mapWireitWorkspace(
  root: string,
  metas: readonly ProjectMeta[],
  opts: MapWireitOptions,
): Promise<WireitMapping> {
  const notes: string[] = []
  const pnp = yarnPnp(root)
  // The root is no vx project in a workspace, so its manifest is read here.
  const rootManifest = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => ({}))) as Raw
  const rootScripts = isRaw(rootManifest['wireit']) ? Object.keys(rootManifest['wireit']) : []
  const byDir = new Map(metas.map((m) => [path.resolve(m.dir), m]))
  const rootMeta = byDir.get(path.resolve(root))
  const configs = new Map(metas.map((m) => [m.name, wireitOf(m)]))

  // A plain npm script a wireit dependency names becomes a task too: wireit runs it.
  const plain = new Map<string, Set<string>>()
  for (const m of metas) {
    for (const cfg of Object.values(configs.get(m.name)!)) {
      for (const d of Array.isArray(cfg['dependencies']) ? cfg['dependencies'] : []) {
        const t = depTarget(m.dir, d)
        const target = t === null ? undefined : byDir.get(t.dir)
        if (target === undefined || t === null) continue
        if (Object.hasOwn(configs.get(target.name)!, t.script)) continue
        const body = packageScripts(target)[t.script]
        if (typeof body === 'string' && body !== '') {
          let set = plain.get(target.name)
          if (set === undefined) plain.set(target.name, (set = new Set()))
          set.add(t.script)
        }
      }
    }
  }
  const emitted = new Map<string, Set<string>>()
  for (const m of metas) {
    emitted.set(
      m.name,
      new Set([...Object.keys(configs.get(m.name)!), ...(plain.get(m.name) ?? [])]),
    )
  }

  const projects: WireitMappedProject[] = []
  for (const meta of metas) {
    const cfgs = configs.get(meta.name)!
    if (meta === rootMeta && metas.length > 1) continue
    const ctx: Ctx = { root, meta, byDir, emitted, opts }
    const tasks = Object.entries(cfgs).map(([name, cfg]) => mapWireitTask(ctx, name, cfg))
    const scripts = packageScripts(meta)
    for (const name of plain.get(meta.name) ?? []) {
      tasks.push({
        name,
        todos: [],
        task: { exec: { command: scriptCommand(name, scripts[name] as string, scripts, pnp) } },
      })
    }
    if (tasks.length > 0) projects.push({ name: meta.name, dir: meta.dir, tasks })
  }
  if (rootScripts.length > 0 && !(rootMeta !== undefined && metas.length === 1)) {
    notes.push(
      `note: the workspace root's wireit scripts (${rootScripts.join(', ')}) are not ` +
        'mapped — vx has no workspace-root tasks',
    )
  }
  pruneDanglingEdges(projects)
  for (const p of projects) resolveSharedOutputs(p.tasks)
  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  return { projects, notes }
}
