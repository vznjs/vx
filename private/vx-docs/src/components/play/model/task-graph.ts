// The task graph widget's model: the story workspace's seven tasks as a
// `Graph` (the graph explorer's own model, read through `parsePlan` from a
// plan in `vx run … --dry --format json`'s shape), plus the two questions the
// widget asks of it. Pure: no DOM, held by tests/play-task-graph.test.ts.
//
// The vx rules it models:
// - `dependsOn: ['^build']` adds an edge to the `build` of each project this
//   one depends on (packages/vx/docs/schema.md, "`'^name'`"). @demo/web
//   depends on @demo/ui; @demo/docs on nothing.
// - A task starts once everything it waits on is done
//   (packages/vx/src/graph/scheduler.ts). With equal task times that is
//   waves: wave n holds the tasks whose longest chain of waits is n long.
// - A task misses when a file its `inputs.files` match changes, and every task
//   that waits on it misses too, because its key folds the upstream's key,
//   never its outputs (packages/vx/docs/caching.md, step 8 "Filtered upstream
//   task cache hashes"). Every other task keeps its key: up to date.

import { parsePlan, upstream, type Graph } from '../../demos/model/graph-explorer.js'
import type { Box, Arrow, Frame, Picture, Tone } from '../../guide/diagram/diagram.js'

export interface StoryTask {
  id: string
  dir: string
  name: string
  command: string
  dependsOn: string[]
  inputs: string[]
}

const PROJECTS: Record<string, string> = {
  '@demo/ui': 'packages/ui',
  '@demo/web': 'packages/web',
  '@demo/docs': 'packages/docs',
}

const t = (
  project: string,
  name: string,
  command: string,
  dependsOn: string[],
  inputs: string[],
): StoryTask => ({
  id: `${project}#${name}`,
  dir: PROJECTS[project]!,
  name,
  command,
  dependsOn,
  inputs,
})

// The configs of running-tasks.mdx: every project declares the same shape.
// `^build` in @demo/ui and @demo/docs resolves to nothing: they use no project.
export const STORY: readonly StoryTask[] = [
  t('@demo/ui', 'build', 'vite build', ['^build'], ['src/**', 'vite.config.ts']),
  t('@demo/ui', 'test', 'vitest run', ['^build'], ['src/**']),
  t('@demo/ui', 'lint', 'oxlint src', [], ['src/**']),
  t('@demo/web', 'build', 'vite build', ['^build'], ['src/**', 'vite.config.ts']),
  t('@demo/web', 'test', 'vitest run', ['^build'], ['src/**']),
  t('@demo/web', 'lint', 'oxlint src', [], ['src/**']),
  t('@demo/docs', 'build', 'vite build', ['^build'], ['src/**', 'vite.config.ts']),
]

const DEPS: Record<string, string[]> = {
  '@demo/web': ['@demo/ui'],
  '@demo/ui': [],
  '@demo/docs': [],
}

const byId = new Map(STORY.map((s) => [s.id, s]))
export const story = (id: string): StoryTask => byId.get(id)!

/** `^name` → the `name` task of each direct dep that declares it. */
function resolve(task: StoryTask): string[] {
  const project = task.id.slice(0, task.id.lastIndexOf('#'))
  return task.dependsOn.flatMap((d) =>
    d.startsWith('^')
      ? DEPS[project]!.map((p) => `${p}#${d.slice(1)}`).filter((id) => byId.has(id))
      : [`${project}#${d}`],
  )
}

/** The story workspace as `vx run --all --dry --format json` would plan it. */
export function storyGraph(): Graph {
  const plan = {
    tasks: STORY.map((s) => ({ id: s.id, cacheStatus: 'miss', deps: resolve(s) })),
  }
  return parsePlan(JSON.stringify(plan)) as Graph
}

/** The tasks a run of `targets` runs, in waves: wave 1 waits on nothing. */
export function waves(graph: Graph, targets: readonly string[]): string[][] {
  const run = new Set(targets)
  for (const id of targets) for (const u of upstream(graph, id)) run.add(u)
  const level = new Map<string, number>()
  const depth = (id: string): number => {
    const known = level.get(id)
    if (known !== undefined) return known
    const d = 1 + Math.max(0, ...graph.tasks.get(id)!.deps.map(depth))
    level.set(id, d)
    return d
  }
  const out: string[][] = []
  for (const id of run) (out[depth(id) - 1] ??= []).push(id)
  return out.map((w) => w.sort())
}

/** Every task that waits on one of `ids`, directly or through others. */
export function downstream(graph: Graph, ids: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const walk = (n: string) => {
    for (const d of graph.dependents.get(n) ?? []) {
      if (seen.has(d)) continue
      seen.add(d)
      walk(d)
    }
  }
  for (const id of ids) walk(id)
  return seen
}

/** A glob as `inputs.files` writes it: `**` crosses folders, `*` does not. */
export function matches(glob: string, file: string): boolean {
  const re = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  return new RegExp(`^${re}$`).test(file)
}

export interface Reruns {
  /** Tasks whose inputs read the edited file. */
  edited: string[]
  /** Tasks that wait on an edited task: their keys fold its key. */
  cascade: string[]
  upToDate: string[]
}

/** What reruns after `file` (a workspace path) changes. */
export function reruns(graph: Graph, file: string): Reruns {
  const edited = STORY.filter(
    (s) =>
      file.startsWith(`${s.dir}/`) &&
      s.inputs.some((g) => matches(g, file.slice(s.dir.length + 1))),
  ).map((s) => s.id)
  const cascade = [...downstream(graph, edited)].filter((id) => !edited.includes(id)).sort()
  const miss = new Set([...edited, ...cascade])
  return { edited, cascade, upToDate: STORY.map((s) => s.id).filter((id) => !miss.has(id)) }
}

/** The files the reader can edit, one chip each. */
export const EDITS = [
  'packages/ui/src/Button.tsx',
  'packages/ui/vite.config.ts',
  'packages/web/src/App.tsx',
  'packages/docs/src/main.ts',
  'packages/ui/README.md',
] as const

export const CAPTION = {
  order: "A wave's tasks run side by side. The next wave starts when they finish.",
  rerun: 'A task reruns when a file it reads changes, or a task it waits on reruns.',
}

/** The runs the reader can ask for besides clicking one task. */
export const NAMES = ['build', 'test', 'lint'] as const

export const allOf = (name: string): string[] =>
  STORY.filter((s) => s.name === name).map((s) => s.id)

const list = (ids: readonly string[]): string =>
  ids.length <= 1 ? (ids[0] ?? '') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`

const wave = (ids: readonly string[]): string =>
  ids.length > 1 ? `${list(ids)} together` : ids[0]!

export function orderSentence(ws: readonly string[][]): string {
  if (ws.length === 1) {
    return ws[0]!.length === 1
      ? `vx runs ${ws[0]![0]}. It waits on nothing.`
      : `vx runs ${list(ws[0]!)} together. None waits on another.`
  }
  return `vx runs ${wave(ws[0]!)} first, then ${ws.slice(1).map(wave).join(', then ')}.`
}

export function rerunSentence(graph: Graph, file: string, r: Reruns): string {
  if (r.edited.length === 0)
    return `No task reads ${file}. All ${r.upToDate.length} stay up to date.`
  const verb = (ids: readonly string[], one: string, many: string) =>
    ids.length === 1 ? one : many
  const parts = [`${list(r.edited)} ${verb(r.edited, 'reads', 'read')} it: cache miss.`]
  if (r.cascade.length > 0) {
    const from = [
      ...new Set(
        r.cascade.flatMap((id) => graph.tasks.get(id)!.deps.filter((d) => r.edited.includes(d))),
      ),
    ].sort()
    parts.push(
      `${list(r.cascade)} ${verb(r.cascade, 'reruns', 'rerun')} too: ` +
        `${verb(r.cascade, 'its key includes', 'their keys include')} ${list(from)}'s key.`,
    )
  }
  if (r.upToDate.length > 0) parts.push(`The other ${r.upToDate.length} stay up to date.`)
  return parts.join(' ')
}

export interface Line {
  text: string
  tone?: 'accent' | 'warn'
}

/** The `dependsOn` lines behind the edges a run of `targets` follows. */
export function orderExcerpt(graph: Graph, targets: readonly string[]): Line[] {
  const s = story(targets.find((id) => graph.tasks.get(id)!.deps.length > 0) ?? targets[0]!)
  const deps = graph.tasks.get(s.id)!.deps
  return [
    { text: `// ${s.dir}/vx.config.ts` },
    { text: `${s.name}: {` },
    ...(s.dependsOn.length > 0
      ? [
          {
            text: `  dependsOn: [${s.dependsOn.map((d) => `'${d}'`).join(', ')}], // → ${deps.length > 0 ? deps.join(', ') : 'nothing: it uses no project'}`,
            tone: 'accent' as const,
          },
        ]
      : []),
    { text: `  exec: { command: '${s.command}' },` },
    ...(s.dependsOn.length > 0
      ? []
      : [{ text: '  // no dependsOn: waits on nothing', tone: 'accent' as const }]),
    { text: '},' },
  ]
}

/** The `inputs.files` of each task in the edited file's project. */
export function rerunExcerpt(file: string): Line[] {
  const tasks = STORY.filter((s) => file.startsWith(`${s.dir}/`))
  const rel = file.slice(tasks[0]!.dir.length + 1)
  return [
    { text: `// ${tasks[0]!.dir}/vx.config.ts` },
    ...tasks.map((s) => {
      const hit = s.inputs.some((g) => matches(g, rel))
      return {
        text: `${`${s.name}:`.padEnd(7)}{ inputs: { files: [${s.inputs.map((g) => `'${g}'`).join(', ')}] } },`,
        ...(hit ? { tone: 'warn' as const } : {}),
      }
    }),
  ]
}

export interface View {
  sentence: string
  lines: Line[]
  /** Each task's tone and the word under its name. */
  boxes: Map<string, { tone: Tone; sub: string }>
  /** `from>to` → tone. */
  arrows: Map<string, Tone>
}

export function orderView(graph: Graph, targets: readonly string[]): View {
  const ws = waves(graph, targets)
  const at = new Map(ws.flatMap((w, i) => w.map((id) => [id, i + 1] as const)))
  const boxes = new Map(
    STORY.map((s) => {
      const n = at.get(s.id)
      const tone: Tone = targets.includes(s.id) ? 'accent' : n === undefined ? 'muted' : 'default'
      return [s.id, { tone, sub: n === undefined ? 'not in run' : `wave ${n}` }] as const
    }),
  )
  return {
    sentence: orderSentence(ws),
    lines: orderExcerpt(graph, targets),
    boxes,
    arrows: edgeTones(graph, (from, to) => (at.has(from) && at.has(to) ? 'accent' : 'muted')),
  }
}

export function rerunView(graph: Graph, file: string): View {
  const r = reruns(graph, file)
  const boxes = new Map<string, { tone: Tone; sub: string }>()
  for (const id of r.edited) boxes.set(id, { tone: 'warn', sub: 'reruns' })
  for (const id of r.cascade) boxes.set(id, { tone: 'warn', sub: 'reruns too' })
  for (const id of r.upToDate) boxes.set(id, { tone: 'ok', sub: 'up to date' })
  const miss = new Set([...r.edited, ...r.cascade])
  return {
    sentence: rerunSentence(graph, file, r),
    lines: rerunExcerpt(file),
    boxes,
    arrows: edgeTones(graph, (from, to) => (miss.has(from) && miss.has(to) ? 'warn' : 'muted')),
  }
}

function edgeTones(graph: Graph, tone: (from: string, to: string) => Tone): Map<string, Tone> {
  return new Map(
    [...graph.tasks.values()].flatMap((t) =>
      t.deps.map((d) => [`${d}>${t.id}`, tone(d, t.id)] as const),
    ),
  )
}

// The drawing, in the diagram kit's units: a dashed frame per project, a box
// per task. Wide: projects side by side. Narrow (a phone): stacked.
const ROWS = ['build', 'test', 'lint']
const COLS = Object.keys(PROJECTS)

function layout(
  narrow: boolean,
): Pick<Picture, 'width' | 'height' | 'boxes' | 'arrows' | 'frames'> {
  const frames: Frame[] = []
  const boxes: Box[] = []
  COLS.forEach((p, i) => {
    const tasks = STORY.filter((s) => s.id.startsWith(`${p}#`))
    const f = narrow
      ? { x: 4, y: 4 + i * 128, w: 352, h: 104 }
      : { x: 4 + i * 198, y: 4, w: 184, h: 272 }
    frames.push({ ...f, label: p })
    for (const s of tasks) {
      const r = ROWS.indexOf(s.name)
      boxes.push({
        id: s.id,
        label: s.name,
        sub: '',
        title: `${s.id}: ${s.command}`,
        ...(narrow
          ? { x: f.x + 10 + r * 114, y: f.y + 32, w: 104 }
          : { x: f.x + 17, y: f.y + 32 + r * 80, w: 150 }),
      })
    }
  })
  const arrows: Arrow[] = STORY.flatMap((s) => resolve(s).map((d) => ({ from: d, to: s.id })))
  return narrow
    ? { width: 360, height: 388, boxes, arrows, frames }
    : { width: 600, height: 280, boxes, arrows, frames }
}

export const WIDE = layout(false)
export const NARROW = layout(true)
