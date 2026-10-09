// The headline benchmark's workspace (owner's spec, 2026-10-09 18:07–18:11):
// 29 levels of 50 libs and a last level of 100 apps; 50 more libs at level
// 15 that nothing depends on; one `e2e` project depending on every edge
// (the apps and those 50). Cross-level edges, no cycles: a project depends
// only on lower levels. Five core libs most projects use, 20 source files
// per project, a `typecheck` task, and each build writes 200 KB of seeded
// incompressible bytes. Durations keep the owner's ratios (build 1, lint
// 0.25, test 0.5, publish 0.1) scaled by BENCH_BUILD_MS: a task only has to
// outlast any runner's own per-task work.
//
// Pure data: compare.ts writes it out for every runner, `idealOf` turns it
// into the graph the ideal schedule runs over, and the edit scenarios read
// which tasks an edit reaches from it.

import type { GraphNode } from './ideal.js'
import { prng } from './schedule-policy.js'

export const LEVELS = 30
export const PER_LEVEL = 50
export const APPS = 100
const TERMINAL_LEVEL = 15
export const TERMINALS = 50
const CORE = 5
export const SOURCE_FILES = 20

export type TaskName = 'installDeps' | 'build' | 'lint' | 'test' | 'publish' | 'typecheck'
export type Kind = 'core' | 'lib' | 'terminal' | 'app' | 'e2e'

export interface Project {
  name: string
  dir: string
  level: number
  kind: Kind
  deps: string[]
  /** Duration in ms of each task the project has; `installDeps` runs nothing. */
  tasks: Partial<Record<TaskName, number>>
}

/** What each task waits for: `^` is the dependencies' task. */
export const DEPENDS_ON: Record<TaskName, readonly string[]> = {
  installDeps: ['^build'],
  build: ['installDeps'],
  lint: ['installDeps'],
  test: ['installDeps'],
  publish: ['build'],
  typecheck: ['^build'],
}

export const RUN_TASKS: readonly TaskName[] = ['build', 'lint', 'test', 'publish', 'typecheck']

export const BUILD_MS = Number(process.env.BENCH_BUILD_MS ?? 1000)
const OUTPUT_BYTES = 200 * 1024

export function workspace(): Project[] {
  const projects: Project[] = []
  const lib = (level: number, idx: number) => `@bench/l${level}-${idx}`
  const levelOf = new Map<string, number>()

  for (let level = 1; level <= LEVELS; level++) {
    const app = level === LEVELS
    for (let idx = 1; idx <= (app ? APPS : PER_LEVEL); idx++) {
      const name = app ? `@bench/app-${idx}` : lib(level, idx)
      projects.push(project(name, level, app ? 'app' : level === 1 && idx <= CORE ? 'core' : 'lib'))
      levelOf.set(name, level)
    }
    if (level === TERMINAL_LEVEL) {
      for (let idx = 1; idx <= TERMINALS; idx++)
        projects.push(project(`@bench/t${level}-${idx}`, level, 'terminal'))
    }
  }

  // Deps: the same index one level down (so every lib has a dependent and
  // the levels are real), 2–5 more from the five levels below, and each
  // core lib with probability 0.25 (~400 dependents each).
  for (const p of projects) {
    if (p.level === 1) continue
    const r = prng(hash(p.name) ^ 0x5eed)
    const deps = new Set<string>()
    const idx = Number(p.name.match(/-(\d+)$/)![1])
    if (p.kind !== 'terminal') deps.add(lib(p.level - 1, 1 + ((idx - 1) % PER_LEVEL)))
    const extra = 2 + Math.floor(r() * 4)
    while (deps.size < extra + (p.kind === 'terminal' ? 0 : 1)) {
      const lv = Math.max(1, p.level - 1 - Math.floor(r() * 5))
      deps.add(lib(lv, 1 + Math.floor(r() * PER_LEVEL)))
    }
    for (let c = 1; c <= CORE; c++) if (r() < 0.25) deps.add(lib(1, c))
    p.deps = [...deps].sort()
  }

  const e2e = project('@bench/e2e', LEVELS + 1, 'e2e')
  e2e.deps = projects
    .filter((p) => p.kind === 'app' || p.kind === 'terminal')
    .map((p) => p.name)
    .sort()
  projects.push(e2e)
  return projects
}

function project(name: string, level: number, kind: Kind): Project {
  const dir = name.slice('@bench/'.length)
  const b = BUILD_MS
  const tasks: Project['tasks'] =
    kind === 'e2e'
      ? { installDeps: 0, lint: b / 4, test: b / 2 }
      : { installDeps: 0, build: b, lint: b / 4, test: b / 2, publish: b / 10, typecheck: b / 2 }
  return { name, dir, level, kind, deps: [], tasks }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** `sleep` in seconds, as every runner's command spells it. */
const sleepOf = (ms: number): string => `sleep ${(ms / 1000).toFixed(3)}`

/**
 * A task's command, identical in every runner. `build` also writes
 * dist/index.js from the sources plus a checksum of its dependencies'
 * dist/index.js (so an upstream change reaches every output downstream, as
 * a bundle's would), and OUTPUT_BYTES of AES-CTR keystream keyed
 * by the project's name: seeded, the same bytes every run, and
 * incompressible, so no cache can shrink the artifact away.
 */
export function command(p: Project, task: TaskName): string {
  const sleep = sleepOf(p.tasks[task]!)
  if (task !== 'build') return sleep
  const key = (
    hash(p.name).toString(16).padStart(8, '0') + hash(`${p.name}#`).toString(16).padStart(8, '0')
  ).repeat(2)
  return (
    `${sleep} && mkdir -p dist && cat src/*.js > dist/index.js && ` +
    (p.deps.length === 0
      ? ''
      : `cat ${p.deps.map((d) => `../${d.slice('@bench/'.length)}/dist/index.js`).join(' ')} | cksum >> dist/index.js && `) +
    `openssl enc -aes-128-ctr -K ${key} -iv 0 -in /dev/zero 2>/dev/null | head -c ${OUTPUT_BYTES} > dist/blob.bin`
  )
}

/** One source file's text; `n` varies it so files differ. */
export const source = (name: string, n: number, edit = 0): string =>
  `// ${name} f${n}\nexport const v${n} = ${JSON.stringify(`${name}:${n}:${edit}`)}\n` +
  `export function f${n}(x) {\n  return x + ${n}\n}\n`

/**
 * The task graph as the ideal schedule sees it. `only`, when given, keeps
 * just those task ids (an edit's re-run), with edges among them.
 */
export function idealOf(projects: readonly Project[], only?: ReadonlySet<string>): GraphNode[] {
  const nodes: GraphNode[] = []
  const at = new Map<string, number>()
  const byName = new Map(projects.map((p) => [p.name, p]))
  for (const p of projects)
    for (const [t, dur] of Object.entries(p.tasks)) {
      const id = `${p.name}#${t}`
      if (only && !only.has(id)) continue
      at.set(id, nodes.length)
      nodes.push({ id, dur: dur!, deps: [] })
    }
  for (const p of projects)
    for (const t of Object.keys(p.tasks) as TaskName[]) {
      const me = at.get(`${p.name}#${t}`)
      if (me === undefined) continue
      for (const dep of upstream(p, t, byName)) {
        const d = at.get(dep)
        if (d !== undefined) nodes[me]!.deps.push(d)
      }
    }
  return nodes
}

function upstream(p: Project, t: TaskName, byName: Map<string, Project>): string[] {
  const out: string[] = []
  for (const spec of DEPENDS_ON[t]) {
    if (spec.startsWith('^')) {
      const task = spec.slice(1)
      for (const d of p.deps) if (task in byName.get(d)!.tasks) out.push(`${d}#${task}`)
    } else if (spec in p.tasks) out.push(`${p.name}#${spec}`)
  }
  return out
}

/**
 * The task ids an edit to `edited`'s sources re-runs: its own tasks with
 * inputs (all but `installDeps`) and every task downstream of them.
 */
export function affectedBy(projects: readonly Project[], edited: string): Set<string> {
  const byName = new Map(projects.map((p) => [p.name, p]))
  const down = new Map<string, string[]>()
  for (const p of projects)
    for (const t of Object.keys(p.tasks) as TaskName[])
      for (const u of upstream(p, t, byName)) {
        const list = down.get(u) ?? []
        list.push(`${p.name}#${t}`)
        down.set(u, list)
      }
  const seen = new Set<string>()
  const stack = Object.keys(byName.get(edited)!.tasks)
    .filter((t) => t !== 'installDeps')
    .map((t) => `${edited}#${t}`)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(down.get(id) ?? []))
  }
  return seen
}

/** The edit scenarios: a lib nothing but `e2e` uses, and the first core lib. */
export const LEAF_EDIT = `@bench/t${TERMINAL_LEVEL}-1`
export const CORE_EDIT = '@bench/l1-1'
