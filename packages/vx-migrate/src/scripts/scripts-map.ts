// A workspace with no orchestrator: the root package.json's scripts fan
// one script out to the packages through the package manager —
// `pnpm -r run build`, `npm run test --workspaces`, `yarn workspaces
// foreach -t run build`, `bun --filter '*' build`, `lerna run build`. Each
// fan-out is a vx task in every package it selects, with a `^name` edge
// where the tool orders by the dependency graph (pnpm and lerna sort
// unless told `--parallel` / `--no-sort`; yarn with `-t`; bun always; npm
// runs in declaration order, and `^name` is the order that holds for any
// declaration). Nothing is cached: a script declares no inputs or outputs.
// Two consumers, one mapper: `workspaceScripts()` fills the `project`
// stage live, and `bunx @vzn/vx-migrate --from scripts` writes the same.

import path from 'node:path'
import type { ProjectMeta } from '@vzn/vx'
import { shellQuote } from '../nx-command.js'
import { packageScripts, relPosix } from '../paths.js'
import { pruneOrphanPersistentNotes } from '../persistent-note.js'
import { scriptCommand, yarnPnp } from '../script-command.js'

type Raw = Record<string, unknown>

// A dev server or watcher by its name. Core's `vx init` keeps its own list
// (PERSISTENT_TASK_NAMES), which the façade does not export.
const LONG_RUNNING = /^(dev|start|serve|watch|preview)$/

export interface ScriptsMappedTask {
  name: string
  todos: string[]
  task: Record<string, unknown> | null
}

export interface ScriptsMappedProject {
  name: string
  dir: string
  tasks: ScriptsMappedTask[]
}

export interface ScriptsMapping {
  projects: ScriptsMappedProject[]
  notes: string[]
}

export interface MapScriptsOptions {
  persistentTodo: string
}

/** One fan-out: which script, over which packages, ordered by the graph or not. */
export interface FanOut {
  tool: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'lerna'
  script: string
  /** Package selectors; empty is every package. */
  include: string[]
  exclude: string[]
  sorted: boolean
}

/**
 * Shell words of one command, quotes removed and adjacent pieces joined
 * (`--filter='./packages/*'` is one word); null for an unclosed quote.
 */
function words(cmd: string): string[] | null {
  const out: string[] = []
  let cur: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur)
      cur = null
    } else if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1)
      if (end === -1) return null
      cur = (cur ?? '') + cmd.slice(i + 1, end).replace(c === '"' ? /\\(.)/g : /$^/, '$1')
      i = end
    } else cur = (cur ?? '') + c
  }
  if (cur !== null) out.push(cur)
  return out
}

/** The value after a flag, as `--flag v` or `--flag=v`; advances `i`. */
function flagValue(w: string[], i: { n: number }, name: string): string | undefined {
  const a = w[i.n]!
  if (a.startsWith(`${name}=`)) return a.slice(name.length + 1)
  i.n++
  return w[i.n]
}

/**
 * The fan-out one command is, or null when it is not one. Leading
 * `VAR=value` assignments are the command's environment and are skipped.
 */
export function parseFanOut(command: string): FanOut | null {
  const w = words(command)
  if (w === null) return null
  while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift()
  let [bin, ...rest] = w
  // `pnpm lerna run watch`, `yarn exec lerna …`: lerna through the manager
  // (docusaurus' `watch`, 2026-09-28).
  if (bin === 'npx' || bin === 'pnpm' || bin === 'yarn' || bin === 'bunx') {
    const at = rest[0] === 'exec' ? 1 : 0
    if (rest[at] === 'lerna') [bin, ...rest] = rest.slice(at)
  }
  if (bin === 'pnpm') return pnpmFanOut(rest)
  if (bin === 'npm') return npmFanOut(rest)
  if (bin === 'yarn') return yarnFanOut(rest)
  if (bin === 'bun') return bunFanOut(rest)
  if (bin === 'lerna') return lernaFanOut(rest)
  return null
}

function pnpmFanOut(w: string[]): FanOut | null {
  const out: FanOut = { tool: 'pnpm', script: '', include: [], exclude: [], sorted: true }
  let recursive = false
  let filtered = false
  const positional: string[] = []
  for (const i = { n: 0 }; i.n < w.length; i.n++) {
    const a = w[i.n]!
    if (a === '-r' || a === '--recursive') recursive = true
    else if (a === '--parallel' || a === '--no-sort') out.sorted = false
    else if (a === '--filter' || a.startsWith('--filter=') || a === '-F') {
      const v = flagValue(w, i, a === '-F' ? '-F' : '--filter')
      if (v === undefined) return null
      filtered = true
      if (v.startsWith('!')) out.exclude.push(v.slice(1))
      else out.include.push(v)
    } else if (a === '-C' || a === '--dir' || a.startsWith('--dir=')) {
      // `pnpm -C packages/pinia build` runs the script in that one package
      // (pinia's own `build`, 98587ca).
      const v = flagValue(w, i, a === '-C' ? '-C' : '--dir')
      if (v === undefined) return null
      filtered = true
      out.include.push(v.startsWith('.') ? v : `./${v}`)
    } else if (/^--(workspace-concurrency|reporter|aggregate-output)/.test(a)) {
      if (!a.includes('=') && !a.startsWith('--aggregate-output')) i.n++
    } else if (a.startsWith('-')) continue
    else positional.push(a)
  }
  // `pnpm --filter x build` fans out as `pnpm -r` does over what it selects.
  if (!recursive && !filtered) return null
  const [first, second] = positional
  if (first === 'exec' || first === 'install' || first === 'add' || first === undefined) return null
  out.script = first === 'run' ? (second ?? '') : first
  return out.script === '' ? null : out
}

function npmFanOut(w: string[]): FanOut | null {
  // `npm -C docs run build` runs one package's script (unocss' `deploy`).
  let prefix: string | undefined
  while (w[0] === '-C' || w[0] === '--prefix' || w[0]?.startsWith('--prefix=') === true) {
    const i = { n: 0 }
    prefix = flagValue(w, i, w[0] === '-C' ? '-C' : '--prefix')
    if (prefix === undefined) return null
    w = w.slice(i.n + 1)
  }
  if (w[0] !== 'run' && w[0] !== 'run-script' && w[0] !== 'test') return null
  const out: FanOut = {
    tool: 'npm',
    script: w[0] === 'test' ? 'test' : '',
    include: [],
    exclude: [],
    sorted: true,
  }
  let all = false
  for (const i = { n: 1 }; i.n < w.length; i.n++) {
    const a = w[i.n]!
    if (a === '--workspaces' || a === '-ws') all = true
    else if (a === '--workspace' || a.startsWith('--workspace=') || a === '-w') {
      const v = flagValue(w, i, a === '-w' ? '-w' : '--workspace')
      // npm takes a name or a path; a path is `./`-rooted in the filter DSL.
      if (v !== undefined) out.include.push(/^[^@.].*\//.test(v) ? `./${v}` : v)
    } else if (a === '--') break
    else if (a.startsWith('-')) continue
    else if (out.script === '') out.script = a
  }
  if (prefix !== undefined && !all && out.include.length === 0) {
    out.include.push(prefix.startsWith('.') ? prefix : `./${prefix}`)
  }
  if (!all && out.include.length === 0) return null
  return out.script === '' ? null : out
}

function yarnFanOut(w: string[]): FanOut | null {
  const out: FanOut = { tool: 'yarn', script: '', include: [], exclude: [], sorted: true }
  // `yarn workspace <name> [run] <script>`: the script in one workspace.
  if (w[0] === 'workspace' && w[1] !== undefined) {
    out.include.push(w[1])
    out.script = (w[2] === 'run' ? w[3] : w[2]) ?? ''
    return out.script === '' ? null : out
  }
  if (w[0] !== 'workspaces') return null
  // yarn 1: `yarn workspaces run <script>`, one after another in order.
  if (w[1] === 'run') {
    out.script = w[2] ?? ''
    return out.script === '' ? null : out
  }
  if (w[1] !== 'foreach') return null
  let topological = false
  let parallel = false
  for (const i = { n: 2 }; i.n < w.length; i.n++) {
    const a = w[i.n]!
    if (a === 'run') {
      out.script = w[i.n + 1] ?? ''
      break
    }
    if (a === '-t' || a === '--topological' || a === '--topological-dev') topological = true
    else if (a === '-p' || a === '--parallel') parallel = true
    else if (a === '--include' || a.startsWith('--include=')) {
      const v = flagValue(w, i, '--include')
      if (v !== undefined) out.include.push(v)
    } else if (a === '--exclude' || a.startsWith('--exclude=')) {
      const v = flagValue(w, i, '--exclude')
      if (v !== undefined) out.exclude.push(v)
    } else if (/^-[a-zA-Z]{2,}$/.test(a)) {
      // Combined short flags: `-ptA`.
      if (a.includes('t')) topological = true
      if (a.includes('p')) parallel = true
    } else if (!a.startsWith('-')) {
      out.script = a
      break
    }
  }
  out.sorted = topological || !parallel
  return out.script === '' ? null : out
}

function bunFanOut(w: string[]): FanOut | null {
  const out: FanOut = { tool: 'bun', script: '', include: [], exclude: [], sorted: true }
  let filtered = false
  for (const i = { n: 0 }; i.n < w.length; i.n++) {
    const a = w[i.n]!
    if (a === '--filter' || a.startsWith('--filter=') || a === '-F') {
      const v = flagValue(w, i, a === '-F' ? '-F' : '--filter')
      if (v === undefined) return null
      filtered = true
      if (v.startsWith('!')) out.exclude.push(v.slice(1))
      else if (v !== '*') out.include.push(v)
    } else if (a === 'run') continue
    else if (a.startsWith('-')) continue
    else if (out.script === '') out.script = a
  }
  return filtered && out.script !== '' ? out : null
}

function lernaFanOut(w: string[]): FanOut | null {
  if (w[0] !== 'run') return null
  const out: FanOut = { tool: 'lerna', script: '', include: [], exclude: [], sorted: true }
  for (const i = { n: 1 }; i.n < w.length; i.n++) {
    const a = w[i.n]!
    if (a === '--parallel' || a === '--no-sort') out.sorted = false
    else if (a === '--scope' || a.startsWith('--scope=')) {
      const v = flagValue(w, i, '--scope')
      if (v !== undefined) out.include.push(v)
    } else if (a === '--ignore' || a.startsWith('--ignore=')) {
      const v = flagValue(w, i, '--ignore')
      if (v !== undefined) out.exclude.push(v)
    } else if (a === '--') break
    else if (a.startsWith('-')) continue
    else if (out.script === '') out.script = a
  }
  return out.script === '' ? null : out
}

/** A root script's commands, split on the chain operators; null when it holds other shell. */
function commandsOf(body: string): { cmds: string[]; chained: boolean } | null {
  if (/[|<>`$(]/.test(body.replace(/&&|\|\|/g, ''))) return null
  const cmds = body
    .split(/&&|;/)
    .map((c) => c.trim())
    .filter(Boolean)
  return { cmds, chained: cmds.length > 1 }
}

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The packages a selector names: a name glob, a `./path` glob, or either with `...` for deps/dependents. */
function select(
  selector: string,
  root: string,
  metas: readonly ProjectMeta[],
  deps: ReadonlyMap<string, readonly string[]>,
): Set<string> | null {
  let s = selector.replace(/^\{(.*)\}$/, '$1')
  if (/\[.*\]/.test(s)) return null
  let withDeps = false
  let withDependents = false
  if (s.endsWith('...')) {
    withDeps = true
    s = s.slice(0, -3).replace(/\^$/, '')
  }
  if (s.startsWith('...')) {
    withDependents = true
    s = s.slice(3).replace(/^\^/, '')
  }
  const out = new Set<string>()
  const byPath = s.startsWith('./') || s.startsWith('../') || s === '.'
  const glob = new Bun.Glob(byPath ? path.posix.normalize(s).replace(/\/$/, '') : s)
  for (const m of metas) {
    const rel = relPosix(root, m.dir) || '.'
    const hit = byPath
      ? glob.match(rel) || glob.match(`${rel}/`)
      : glob.match(m.name) || m.name === s
    if (hit) out.add(m.name)
  }
  if (withDeps) {
    const stack = [...out]
    while (stack.length > 0) {
      for (const d of deps.get(stack.pop()!) ?? []) {
        if (out.has(d)) continue
        out.add(d)
        stack.push(d)
      }
    }
  }
  if (withDependents) {
    let grew = true
    while (grew) {
      grew = false
      for (const [name, ds] of deps) {
        if (out.has(name) || !ds.some((d) => out.has(d))) continue
        out.add(name)
        grew = true
      }
    }
  }
  return out
}

export function mapScriptsWorkspace(
  root: string,
  rootScripts: Readonly<Record<string, unknown>>,
  metas: readonly ProjectMeta[],
  opts: MapScriptsOptions,
): ScriptsMapping {
  const notes: string[] = []
  const members = metas.filter((m) => path.resolve(m.dir) !== path.resolve(root))
  const names = new Set(members.map((m) => m.name))
  const deps = new Map<string, string[]>()
  for (const m of members) {
    const pj = m.packageJson as unknown as Raw
    deps.set(
      m.name,
      DEP_FIELDS.flatMap((f) => (isRaw(pj[f]) ? Object.keys(pj[f]) : [])).filter(
        (d) => names.has(d) && d !== m.name,
      ),
    )
  }

  // Per package: script name → { sorted, same-package scripts a chain ran before it }.
  const planned = new Map<string, Map<string, { sorted: boolean; after: Set<string> }>>()
  const rootOnly: string[] = []
  const unparsed: string[] = []
  const renamed: string[] = []
  for (const [rootName, body] of Object.entries(rootScripts)) {
    if (typeof body !== 'string') continue
    const parsed = commandsOf(body)
    const fans = parsed?.cmds.map(parseFanOut) ?? []
    if (!fans.some((f) => f !== null)) continue
    if (parsed === null) {
      unparsed.push(rootName)
      continue
    }
    const before: string[] = []
    // What the team types instead: each fan-out as `vx run`, its selectors as
    // `--filter` (vx's DSL is pnpm's) where they narrow the script's holders.
    const runs: { script: string; filters: string[] }[] = []
    for (const [k, fan] of fans.entries()) {
      if (fan === null) {
        rootOnly.push(`${rootName} (\`${parsed.cmds[k]}\`)`)
        continue
      }
      let selected = new Set<string>(fan.include.length === 0 ? names : [])
      let unknownSelector = false
      for (const sel of fan.include) {
        const hit = select(sel, root, members, deps)
        if (hit === null) unknownSelector = true
        else for (const n of hit) selected.add(n)
      }
      if (unknownSelector) selected = new Set(names)
      for (const sel of fan.exclude)
        for (const n of select(sel, root, members, deps) ?? []) selected.delete(n)
      if (unknownSelector) {
        notes.push(
          `note: root script ${rootName}: a since-ref selector (\`[ref]\`) selects by git history, which a mapping cannot — every package with the script takes it`,
        )
      }
      const holders = members.filter((m) => {
        const b = packageScripts(m)[fan.script]
        return typeof b === 'string' && b !== ''
      })
      runs.push({
        script: fan.script,
        filters:
          !unknownSelector && holders.every((m) => selected.has(m.name))
            ? []
            : [...fan.include, ...fan.exclude.map((e) => `!${e}`)],
      })
      for (const m of holders) {
        if (!selected.has(m.name)) continue
        let tasks = planned.get(m.name)
        if (tasks === undefined) planned.set(m.name, (tasks = new Map()))
        const entry = tasks.get(fan.script) ?? { sorted: false, after: new Set<string>() }
        entry.sorted ||= fan.sorted
        for (const b of before) if (b !== fan.script) entry.after.add(b)
        tasks.set(fan.script, entry)
      }
      before.push(fan.script)
    }
    // `pnpm ci` is `vx run build test --all`: the command a team types, said once.
    const narrowed = runs.some((r) => r.filters.length > 0)
    if (runs.length > 0 && (narrowed || !before.includes(rootName))) {
      // From the root, a bare `vx run` names no project: `--all` is the fan-out.
      const flags = (fs: string[]) =>
        fs.length === 0 ? ' --all' : fs.map((f) => ` --filter ${shellQuote(f)}`).join('')
      const key = (r: (typeof runs)[number]) => flags(r.filters)
      const same = runs.every((r) => key(r) === key(runs[0]!))
      const line = same
        ? `vx run ${[...new Set(before)].join(' ')}${key(runs[0]!)}`
        : runs.map((r) => `vx run ${r.script}${key(r)}`).join(' && ')
      renamed.push(`\`${rootName}\` is \`${line}\``)
    }
  }
  if (rootOnly.length > 0) {
    notes.push(
      `note: root script commands that run at the workspace root are not mapped — vx has no workspace-root tasks: ${rootOnly.join(', ')}`,
    )
  }
  if (unparsed.length > 0) {
    notes.push(
      `note: root scripts with pipes, redirects or substitutions are not mapped: ${unparsed.join(', ')}`,
    )
  }
  if (renamed.length > 0) notes.push(`note: ${renamed.join(', ')}`)

  const emitted = (pkg: string, s: string) => planned.get(pkg)?.has(s) === true
  const pnp = yarnPnp(root)
  const projects: ScriptsMappedProject[] = []
  for (const m of members) {
    const tasks = planned.get(m.name)
    if (tasks === undefined) continue
    const scripts = packageScripts(m)
    const out: ScriptsMappedTask[] = []
    for (const [name, entry] of tasks) {
      const todos: string[] = []
      const exec: Record<string, unknown> = {
        command: scriptCommand(name, scripts[name] as string, scripts, pnp),
      }
      if (LONG_RUNNING.test(name)) {
        exec['persistent'] = {}
        todos.push(opts.persistentTodo)
      }
      const task: Record<string, unknown> = { exec }
      const dependsOn = [...entry.after].filter((a) => emitted(m.name, a))
      if (entry.sorted) dependsOn.push(`^${name}`)
      if (dependsOn.length > 0) task['dependsOn'] = dependsOn
      out.push({ name, todos, task })
    }
    projects.push({ name: m.name, dir: m.dir, tasks: out })
  }
  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  return { projects, notes }
}
