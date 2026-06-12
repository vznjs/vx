// Turbo → vx mapping. Reads turbo.json (tasks in turbo 2, pipeline in
// turbo 1), per-package turbo.json `extends` overlays, and each
// package's scripts. A task is emitted for a package only when the
// package declares the script (turbo semantics). Global fields become
// a root vx-preset.ts that configs import and spread — TypeScript
// composition replaces turbo's global config.

import path from 'node:path'
import { relPosix, UserError } from '../util/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import type { GeneratedProject, GeneratedTask, MigrationPlan, RawExpr } from './migrate.js'

interface TurboTask {
  dependsOn?: string[]
  inputs?: string[]
  outputs?: string[]
  env?: string[]
  passThroughEnv?: string[]
  cache?: boolean
  persistent?: boolean
  [key: string]: unknown
}

interface TurboJson {
  tasks?: Record<string, TurboTask>
  pipeline?: Record<string, TurboTask>
  globalDependencies?: string[]
  globalEnv?: string[]
  globalPassThroughEnv?: string[]
}

const KNOWN_TASK_KEYS = new Set([
  'dependsOn',
  'inputs',
  'outputs',
  'env',
  'passThroughEnv',
  'cache',
  'persistent',
  'extends',
])

const PRESET_FILE = 'vx-preset.ts'

interface Globals {
  inputs: boolean
  env: boolean
  pass: boolean
}

async function readTurboJson(file: string, root: string): Promise<TurboJson> {
  const text = await Bun.file(file).text()
  try {
    // turbo.json allows comments + trailing commas.
    return (Bun.JSONC.parse(text) ?? {}) as TurboJson
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${relPosix(root, file)}: ${msg}`)
  }
}

function tasksOf(cfg: TurboJson): Record<string, TurboTask> {
  return cfg.tasks ?? cfg.pipeline ?? {}
}

function scriptsOf(meta: ProjectMeta): Record<string, string> {
  return (meta.packageJson as unknown as { scripts?: Record<string, string> }).scripts ?? {}
}

/** Declared task names for a package: plain root keys, `pkg#name` keys
 * for this package, and per-package turbo.json keys — in that order. */
function taskNamesFor(
  pkgName: string,
  rootTasks: Record<string, TurboTask>,
  pkgTasks: Record<string, TurboTask> | undefined,
): string[] {
  const names: string[] = []
  const push = (n: string): void => {
    if (!names.includes(n)) names.push(n)
  }
  for (const key of Object.keys(rootTasks)) {
    if (!key.includes('#')) push(key)
    else if (key.startsWith(`${pkgName}#`)) push(key.slice(pkgName.length + 1))
  }
  for (const key of Object.keys(pkgTasks ?? {})) {
    if (!key.includes('#')) push(key)
  }
  return names
}

export async function migrateTurbo(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<MigrationPlan> {
  const rootCfg = await readTurboJson(path.join(root, 'turbo.json'), root)
  const rootTasks = tasksOf(rootCfg)

  const globalInputs = rootCfg.globalDependencies ?? []
  const globalEnv = rootCfg.globalEnv ?? []
  const globalPass = rootCfg.globalPassThroughEnv ?? []
  const globals: Globals = {
    inputs: globalInputs.length > 0,
    env: globalEnv.length > 0,
    pass: globalPass.length > 0,
  }

  const pkgTasksByName = new Map<string, Record<string, TurboTask>>()
  for (const meta of metas) {
    const file = path.join(meta.dir, 'turbo.json')
    if (await Bun.file(file).exists()) {
      pkgTasksByName.set(meta.name, tasksOf(await readTurboJson(file, root)))
    }
  }

  const notes: string[] = []
  for (const key of Object.keys(rootTasks)) {
    if (key.startsWith('//#')) {
      notes.push(`note: root task ${key} not migrated — vx has no workspace-root tasks`)
    }
  }

  // First pass: which tasks does each package emit? Needed so dependsOn
  // edges can be validated/dropped against the real emitted set.
  const emitted = new Map<string, Set<string>>()
  for (const meta of metas) {
    const scripts = scriptsOf(meta)
    const set = new Set<string>()
    for (const name of taskNamesFor(meta.name, rootTasks, pkgTasksByName.get(meta.name))) {
      if (scripts[name] !== undefined) set.add(name)
    }
    emitted.set(meta.name, set)
  }

  const projects: GeneratedProject[] = []
  for (const meta of metas) {
    const scripts = scriptsOf(meta)
    const pkgTasks = pkgTasksByName.get(meta.name)
    const own = emitted.get(meta.name)!
    const used = new Set<string>()
    const tasks: GeneratedTask[] = []
    for (const name of taskNamesFor(meta.name, rootTasks, pkgTasks)) {
      if (!own.has(name)) continue
      const def: TurboTask = {
        ...rootTasks[name],
        ...rootTasks[`${meta.name}#${name}`],
        ...pkgTasks?.[name],
      }
      tasks.push(buildTask(name, def, scripts[name]!, own, emitted, globals, used))
    }
    projects.push({
      name: meta.name,
      dir: meta.dir,
      importLines: presetImportLines(used, root, meta.dir),
      tasks,
    })
  }

  const extraFiles: MigrationPlan['extraFiles'] = []
  if (globals.inputs || globals.env || globals.pass) {
    extraFiles.push({
      relPath: PRESET_FILE,
      contents: renderPreset(globalInputs, globalEnv, globalPass),
    })
  }

  return { headerNotes: [], projects, extraFiles, notes }
}

function buildTask(
  name: string,
  def: TurboTask,
  command: string,
  own: ReadonlySet<string>,
  emitted: ReadonlyMap<string, ReadonlySet<string>>,
  globals: Globals,
  used: Set<string>,
): GeneratedTask {
  const todos: string[] = []
  const persistent = def.persistent === true
  const cacheEnabled = def.cache !== false && !persistent

  for (const [key, value] of Object.entries(def)) {
    if (KNOWN_TASK_KEYS.has(key)) continue
    todos.push(
      `turbo key ${JSON.stringify(key)} (${JSON.stringify(value)}) has no vx equivalent — ` +
        'map it manually',
    )
  }

  const deps: string[] = []
  for (const d of def.dependsOn ?? []) {
    if (d.includes('$TURBO_ROOT$')) {
      todos.push(
        `dependsOn ${JSON.stringify(d)} uses $TURBO_ROOT$ — vx has no workspace-root tasks; ` +
          'restructure manually',
      )
      continue
    }
    if (d.startsWith('^')) {
      deps.push(d)
      continue
    }
    const hashAt = d.indexOf('#')
    if (hashAt !== -1) {
      const pkg = d.slice(0, hashAt)
      const task = d.slice(hashAt + 1)
      if (emitted.get(pkg)?.has(task)) deps.push(d)
      else
        todos.push(
          `dependsOn ${JSON.stringify(d)}: ${pkg} declares no ${task} script — edge dropped`,
        )
      continue
    }
    // Same-project dep on a script this package lacks: turbo silently
    // skips the task there, so the edge simply doesn't exist.
    if (own.has(d)) deps.push(d)
  }

  const envNames: string[] = []
  for (const e of def.env ?? []) {
    if (/[*?[\]!]/.test(e)) {
      todos.push(
        `env ${JSON.stringify(e)}: wildcards are not supported in vx env names — ` +
          'list explicit names in cache.inputs.env + exec.env.passThrough',
      )
    } else envNames.push(e)
  }
  const passNames: string[] = []
  for (const e of def.passThroughEnv ?? []) {
    if (/[*?[\]!]/.test(e)) {
      todos.push(
        `passThroughEnv ${JSON.stringify(e)}: wildcards are not supported — list explicit names`,
      )
    } else passNames.push(e)
  }

  const passThrough: (string | RawExpr)[] = []
  if (globals.env) {
    passThrough.push({ raw: '...globalEnvInputs' })
    used.add('globalEnvInputs')
  }
  if (globals.pass) {
    passThrough.push({ raw: '...globalPassThroughEnv' })
    used.add('globalPassThroughEnv')
  }
  passThrough.push(...envNames, ...passNames)

  const exec: Record<string, unknown> = { command }
  if (passThrough.length > 0) exec.env = { passThrough }
  if (persistent) {
    exec.persistent = {}
    todos.push(
      'persistent task — set persistent.readyWhen (regex matched against output) so ' +
        'dependents unblock on readiness, and consider readyTimeoutMs',
    )
  }

  const task: Record<string, unknown> = { exec }
  if (deps.length > 0) task.dependsOn = deps

  if (cacheEnabled) {
    const files: (string | RawExpr)[] = []
    if (globals.inputs) {
      files.push({ raw: '...globalInputs' })
      used.add('globalInputs')
    }
    if (def.inputs === undefined) {
      // Turbo's default input set is every package file.
      files.push('**/*')
    } else {
      for (const i of def.inputs) {
        if (i === '$TURBO_DEFAULT$') files.push('**/*')
        else if (i.includes('$TURBO_ROOT$')) {
          todos.push(
            `input ${JSON.stringify(i)} uses $TURBO_ROOT$ — vx inputs are project-relative; ` +
              'relocate the file or fold it into vx-preset.ts globalInputs manually',
          )
        } else files.push(i)
      }
    }

    const outFiles: string[] = []
    for (const o of def.outputs ?? []) {
      if (o.startsWith('!')) {
        todos.push(
          `output ${JSON.stringify(o)}: vx outputs have no negation — narrow the positive ` +
            'globs instead',
        )
      } else outFiles.push(o)
    }

    const cacheEnv: (string | RawExpr)[] = []
    if (globals.env) cacheEnv.push({ raw: '...globalEnvInputs' })
    cacheEnv.push(...envNames)

    const inputs: Record<string, unknown> = { files }
    if (cacheEnv.length > 0) inputs.env = cacheEnv
    task.cache = { inputs, outputs: { files: outFiles } }
  }

  return { name, todos, task }
}

function presetImportLines(used: ReadonlySet<string>, root: string, dir: string): string[] {
  if (used.size === 0) return []
  const rel = relPosix(dir, path.join(root, PRESET_FILE))
  const spec = rel.startsWith('.') ? rel : `./${rel}`
  return [`import { ${[...used].sort().join(', ')} } from '${spec}'`]
}

function renderPreset(inputs: string[], env: string[], pass: string[]): string {
  const arr = (xs: string[]): string => `[${xs.map((x) => `'${x}'`).join(', ')}]`
  const lines = [
    '// Generated by `vx migrate` from turbo.json. TypeScript composition',
    "// replaces turbo's global fields: each vx.config.ts imports these",
    '// arrays and spreads them into the matching task fields.',
  ]
  if (inputs.length > 0) {
    lines.push(
      '',
      '// From globalDependencies. Turbo resolved these against the workspace',
      '// root; vx input globs are project-relative, so entries naming',
      '// root-only files may need to move into the projects that read them.',
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
  lines.push('')
  return lines.join('\n')
}
