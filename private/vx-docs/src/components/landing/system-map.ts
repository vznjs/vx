// The landing's system map: one box per piece a vx run talks to, the
// core's six hook groups, and one real run played over them: the 30-task
// workspace of src/data/hero-run.json, as vx-dte's simulator ran it
// (scripts/hero-run.ts). Workers start when the plan needs them, boot,
// run their tasks and leave when it no longer does; every dot is a named
// message that run sent, in its order. Two layouts (wide, and a phone's), one set
// of wires; SystemMap.astro draws both, HeroStage.astro plays the run.
// tests/landing.test.ts holds the story.

export type Tone = 'core' | 'read' | 'remote' | 'dte' | 'report'
type Side = 'top' | 'bottom' | 'left' | 'right'

export interface Box {
  id: string
  label: string
  /** The package that brings it, or what it is. */
  sub: string
  tone: Tone
  /** Its label where a phone's box is too narrow for it. */
  short?: string
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface End {
  side: Side
  /** Where along the side, 0 to 1. */
  at?: number
}

export interface Wire {
  id: string
  from: string
  to: string
  dashed?: boolean
}

/** One of the core's hook groups: a step of the story and a chip in the core. */
export interface Group {
  id: string
  /** The anchors old links land on, where any do. */
  anchors?: string[]
  title: string
  hooks: string[]
  /** One sentence, backticks as code. */
  line: string
  tone: Tone
}

/** The workers' slots each layout draws: as many as the run had at once. */
export const SLOTS = 3

export const BOXES: Box[] = [
  { id: 'core', label: 'vx', sub: 'one run, every stage', tone: 'core' },
  {
    id: 'ws',
    label: 'Your workspace',
    short: 'Workspace',
    sub: 'vx.config.ts · .vx/workspace.ts',
    tone: 'read',
  },
  { id: 'lockfile', label: 'Lockfile', sub: 'vx-lockfile · pnpm, bun, npm, yarn', tone: 'read' },
  {
    id: 'migrate',
    label: 'Turbo or Nx graph',
    short: 'Turbo / Nx',
    sub: 'vx-migrate · turbo.json, Nx',
    tone: 'read',
  },
  { id: 'history', label: 'History', sub: 'vx-history · task timings', tone: 'read' },
  { id: 'ci', label: 'CI', sub: 'vx-ci · GitHub Actions, GitLab', tone: 'read' },
  { id: 'reports', label: 'Reports', sub: 'vx-otel · traces, metrics, logs', tone: 'report' },
  {
    id: 'relay',
    label: 'Distributed task execution',
    short: 'DTE',
    sub: 'vx-dte · stores nothing',
    tone: 'dte',
  },
  { id: 'cache', label: 'Remote cache', sub: 'vx-cache · S3, R2 or Docker', tone: 'remote' },
]

const slotIds = Array.from({ length: SLOTS }, (_, i) => i + 1)

export const WIRES: Wire[] = [
  { id: 'ws', from: 'ws', to: 'core' },
  { id: 'lockfile', from: 'lockfile', to: 'core' },
  { id: 'migrate', from: 'migrate', to: 'core' },
  { id: 'history', from: 'history', to: 'core' },
  { id: 'ci', from: 'ci', to: 'core' },
  { id: 'reports', from: 'core', to: 'reports' },
  { id: 'cache', from: 'core', to: 'cache' },
  { id: 'relay', from: 'core', to: 'relay' },
  ...slotIds.map((k) => ({ id: `s${k}`, from: 'relay', to: `slot${k}` })),
  ...slotIds.map((k) => ({ id: `c${k}`, from: `slot${k}`, to: 'cache' })),
]

export const GROUPS: Group[] = [
  {
    id: 'setup',
    title: 'Setup',
    hooks: ['config', 'setup'],
    line: 'Your `.vx/workspace.ts` names the plugins, and each one sets up once.',
    tone: 'read',
  },
  {
    id: 'graph',
    anchors: ['tasks', 'changed'],
    title: 'Graph',
    hooks: ['discover', 'project', 'fingerprint', 'graph', 'key'],
    line: 'Your configs, lockfile or a Turbo or Nx graph resolve once into tasks, each keyed on its own inputs.',
    tone: 'read',
  },
  {
    id: 'cache',
    anchors: ['cache'],
    title: 'Cache',
    hooks: ['cache'],
    line: 'Your local cache answers first, then your remote, and a hit puts the files back without running anything.',
    tone: 'remote',
  },
  {
    id: 'schedule',
    anchors: ['parallel'],
    title: 'Schedule',
    hooks: ['measures', 'schedule', 'admit'],
    line: 'History times each task, so the longest chain goes first, and the plan goes to Distributed task execution.',
    tone: 'read',
  },
  {
    id: 'run',
    title: 'Run',
    hooks: ['executor', 'output'],
    line: 'Distributed task execution boots workers as the work needs them and sends them tasks; outputs land in the cache.',
    tone: 'dte',
  },
  {
    id: 'report',
    title: 'Report',
    hooks: ['telemetry', 'teardown'],
    line: 'Every task lands in OpenTelemetry and your job summary, and its time goes back to shared history.',
    tone: 'report',
  },
]

// ---- the run ----

/** src/data/hero-run.json: what scripts/hero-run.ts wrote from vx-dte's simulator. */
export interface Run {
  endMs: number
  tasks: {
    id: string
    deps: string[]
    hit?: boolean
    cores?: number
    worker?: string
    startMs?: number
    endMs?: number
  }[]
  workers: { id: string; cores: number; spawnMs: number; joinMs: number | null; leaveMs: number }[]
}

/** A message on a wire: it leaves at `at` and arrives `TRAVEL_MS` later, named by `label`. */
export interface Dot {
  at: number
  wire: string
  back: boolean
  tone: Tone
  label: string
  /** Its trip, when not `TRAVEL_MS`: a step's one message spans the step (M, 2026-11-18). */
  dur?: number
}

/** A worker on its slot. */
/** A wire talking one way for a while: a steady stream of dots, `back` against the wire (M, 2026-11-18: no chaos). */
export interface Flow {
  wire: string
  back: boolean
  tone: Tone
  from: number
  to: number
}

export interface Lane {
  slot: number
  cores: number
  spawn: number
  join: number
  leave: number
}

/** A task on its worker: where in the worker's cores it sits, `at` cores from the left. */
export interface Bar {
  id: string
  slot: number
  at: number
  cores: number
  start: number
  end: number
}

export interface Play {
  /** The step on screen: one group a `STEP_MS` window, in the order a run reaches them. */
  steps: { group: string; from: number; to: number; boxes: string[]; wires: string[] }[]
  /** When vx calls each group's hooks, [from, to) in play ms: several at once while tasks run. */
  lit: Record<string, [number, number][]>
  dots: Dot[]
  lanes: Lane[]
  bars: Bar[]
  /** When each hit restored. */
  hits: number[]
  /** Each wire's streams: its messages one way, merged while they keep coming. */
  flows: Flow[]
  /** The run's clock: the play ms its first task starts at, the run ms that is, and play ms per run ms. */
  zero: number
  first: number
  scale: number
  /** When the run's last task ended, and when the play starts over. */
  end: number
  loop: number
}

/** A message's trip along one wire, at a pace an eye follows: as slow as Schedule's 5 s allows, its chain (timings, plan, start, boot, join, first task) filling it. */
export const TRAVEL_MS = 600
/** Each step's window (M, 2026-11-18): 5 s, and Run's 10 s, which the tasks' part of the run fills. */
export const STEP_MS = 5000
const RUN_MS = 10_000
/** A worker's boot, shown as 2 s whatever the run's took (M, 2026-11-18). */
export const BOOT_MS = 2000
/** How far apart one way's messages on a wire may be and still read as one stream. */
const MERGE_MS = 1500
/** The steps in the order a run reaches them: the cache's probe answers before the first plan. */
export const ORDER = ['setup', 'graph', 'cache', 'schedule', 'run', 'report'] as const

/** The hook group vx called to send or take a message on a wire of its own; none for one it took no part in. */
function hookOf(d: Dot): (typeof ORDER)[number] | undefined {
  if (/^[sc]\d$/.test(d.wire)) return undefined
  if (d.label === 'config' || d.label === 'CI scope') return 'setup'
  if (d.wire === 'ci') return 'report'
  if (d.wire === 'ws' || d.wire === 'lockfile' || d.wire === 'migrate') return 'graph'
  if (d.wire === 'cache') return 'cache'
  if (d.wire === 'history') return d.back ? 'report' : 'schedule'
  if (d.wire === 'relay') return 'run'
  return 'report'
}

/**
 * The run on one clock, one `STEP_MS` window a group. The tasks keep the
 * simulated run's times, scaled to Run's window; each message plays at a
 * pace an eye follows, in the order the run sent it.
 */
export function play(run: Run): Play {
  const dots: Dot[] = []
  const T = TRAVEL_MS
  const len = (g: (typeof ORDER)[number]): number => (g === 'run' ? RUN_MS : STEP_MS)
  const at = (g: (typeof ORDER)[number]): number =>
    ORDER.slice(0, ORDER.indexOf(g)).reduce((n, x) => n + len(x), 0)
  const loop = at('report') + len('report')
  // The boxes a step works with, and the wires of its one-off reads and
  // writes, lit for its whole window (M, 2026-11-18).
  const WITH: Record<(typeof ORDER)[number], [string[], string[]]> = {
    setup: [
      ['ws', 'ci'],
      ['ws', 'ci'],
    ],
    graph: [
      ['ws', 'lockfile', 'migrate'],
      ['ws', 'lockfile', 'migrate'],
    ],
    cache: [['cache', 'reports'], ['cache']],
    schedule: [
      ['history', 'relay'],
      ['history', 'relay'],
    ],
    run: [['relay', 'cache', 'reports'], []],
    report: [
      ['ci', 'history', 'reports'],
      ['ci', 'history'],
    ],
  }
  const steps = ORDER.map((group) => ({
    group,
    from: at(group),
    to: at(group) + len(group),
    boxes: WITH[group][0],
    wires: WITH[group][1],
  }))
  const dot = (
    when: number,
    wire: string,
    tone: Tone,
    label: string,
    back = false,
    dur?: number,
  ): void => {
    dots.push({ at: when, wire, back, tone, label, ...(dur === undefined ? {} : { dur }) })
  }
  const ran = run.tasks
    .filter((x) => !x.hit)
    .sort((a, b) => a.startMs! - b.startMs! || a.id.localeCompare(b.id))
  const first = ran[0]!.startMs!
  const last = Math.max(...ran.map((x) => x.endMs!))
  const zero = at('run')
  const scale = len('run') / (last - first)
  const t = (ms: number): number => zero + (ms - first) * scale
  const end = t(last)
  // A step whose work is one message lets that message take the whole step.
  const S = STEP_MS
  // Setup: the workspace's config, and the cache scope vx-ci reads from the CI it runs on.
  dot(at('setup'), 'ws', 'read', 'config', false, S)
  dot(at('setup'), 'ci', 'read', 'CI scope', false, S)
  // Graph: the configs, the lockfile and a Turbo or Nx graph resolve into keyed tasks.
  dot(at('graph'), 'ws', 'read', 'projects', false, S)
  dot(at('graph'), 'lockfile', 'read', 'lockfile', false, S)
  dot(at('graph'), 'migrate', 'read', 'graph', false, S)
  // Cache: the probe asks for every key at once, and the hits come back
  // restored without running, half the step each way.
  const probe = at('cache')
  dot(probe, 'cache', 'remote', 'probe', false, S / 2)
  // Schedule: history's timings, then vx hands the plan to DTE, which
  // starts the workers and orchestrates them from here on.
  dot(at('schedule'), 'history', 'read', 'timings')
  dot(at('schedule') + T, 'relay', 'dte', 'plan')

  const byId = new Map(run.tasks.map((x) => [x.id, x]))
  // When a task's inputs are all there: a hit restores then.
  const readyMs = (id: string): number =>
    Math.max(0, ...byId.get(id)!.deps.map((d) => byId.get(d)!.endMs ?? readyMs(d)))
  const held = run.tasks.filter((x) => x.hit)
  const hits = held.map((x) => (readyMs(x.id) <= first ? probe + S / 2 : t(readyMs(x.id))))
  // The hits ready at the start come back as one answer; one ready later restores as it is.
  if (hits.some((h) => h === probe + S / 2)) {
    dot(probe + S / 2, 'cache', 'remote', 'restore', true, S / 2)
    dot(probe + S / 2, 'reports', 'report', 'span', false, S / 2)
  }
  for (const h of hits)
    if (h !== probe + S / 2) {
      dot(h, 'cache', 'remote', 'restore', true)
      dot(h + T, 'reports', 'report', 'span')
    }

  // Each worker takes the first slot free when it starts.
  const workers = [...run.workers].sort((a, b) => a.spawnMs - b.spawnMs)
  const firstJoin = zero - 2 * T
  const free: number[] = []
  const lanes: Lane[] = []
  const slotOf = new Map<string, number>()
  for (const w of workers) {
    // It joins when the run had it join, booted `BOOT_MS` before; the first joins as its first task waits.
    const joinMs = w.joinMs ?? w.leaveMs
    const join = w === workers[0] ? firstJoin : Math.max(firstJoin, t(joinMs) - 2 * T)
    const spawn = join - BOOT_MS - T
    let slot = free.findIndex((until) => until <= spawn)
    if (slot < 0) slot = free.length
    if (slot >= SLOTS) throw new Error(`${w.id}: more than ${SLOTS} workers at once`)
    const leave = t(w.leaveMs) + 2 * T
    free[slot] = leave
    const k = slot + 1
    slotOf.set(w.id, k)
    lanes.push({ slot: k, cores: w.cores, spawn: spawn + T, join, leave })
    // DTE starts it; it boots, then joins DTE; let go, it hears so and stops.
    dot(spawn, `s${k}`, 'dte', 'start')
    if (w.joinMs !== null) dot(join, `s${k}`, 'dte', 'join', true)
    dot(t(w.leaveMs), `s${k}`, 'dte', 'leave')
  }

  const bars: Bar[] = []
  for (const x of ran) {
    const slot = slotOf.get(x.worker!)!
    const start = t(x.startMs!)
    const stop = t(x.endMs!)
    // Its cores sit at the first gap wide enough among the bars running then.
    const busy = bars
      .filter((b) => b.slot === slot && b.start < stop && b.end > start)
      .sort((a, b) => a.at - b.at)
    let from = 0
    for (const b of busy) if (b.at < from + x.cores! && b.at + b.cores > from) from = b.at + b.cores
    const cores = run.workers.find((w) => w.id === x.worker)!.cores
    bars.push({
      id: x.id,
      slot,
      at: Math.min(from, Math.max(0, cores - x.cores!)),
      cores: x.cores!,
      start,
      end: stop,
    })
    // DTE sends the task; the worker restores the inputs another machine
    // made from the cache, then runs.
    const fetches = x.deps.some((d) => byId.get(d)!.worker !== x.worker)
    const order = start - (fetches ? 2 : 1) * T
    dot(order, `s${slot}`, 'dte', 'task')
    if (fetches) dot(start - T, `c${slot}`, 'remote', 'inputs', true)
    // It ends: its outputs go to the cache under its key, its result through
    // DTE to vx, and vx restores the outputs as its own.
    dot(stop, `c${slot}`, 'remote', 'outputs')
    dot(stop, `s${slot}`, 'dte', 'done', true)
    dot(stop + T, 'relay', 'dte', 'done', true)
    dot(stop + 2 * T, 'cache', 'remote', 'restore', true)
    dot(stop + 2 * T, 'reports', 'report', 'span')
  }
  // Report: the job summary is written and the run's timings go back to history.
  const down = Math.max(at('report'), end + 3 * T)
  dot(down, 'ci', 'report', 'summary', true, loop - down)
  dot(down, 'history', 'report', 'timings', true, loop - down)

  // A group lights for its step's window and, outside it, for each other
  // step where vx calls its hooks: a message vx sent or answered through them.
  // What DTE and the workers do with the cache lights nothing in vx.
  const lit: Record<string, [number, number][]> = Object.fromEntries(
    steps.map((x) => [x.group, [[x.from, x.to]] as [number, number][]]),
  )
  dots.sort((a, b) => a.at - b.at)
  // Messages one way on a wire closer than a beat apart are one stream.
  const flows: Flow[] = []
  const open = new Map<string, Flow>()
  for (const d of dots) {
    const k = `${d.wire}:${d.back}`
    const to = d.at + (d.dur ?? T)
    const f = open.get(k)
    if (f && d.at <= f.to + MERGE_MS) f.to = Math.max(f.to, to)
    else {
      const g: Flow = { wire: d.wire, back: d.back, tone: d.tone, from: d.at, to }
      flows.push(g)
      open.set(k, g)
    }
    // A group vx calls in a step stays lit the whole step, never blinking (M, 2026-11-18).
    const h = hookOf(d)
    const step = steps.find((x) => x.from <= d.at && d.at < x.to)
    if (h !== undefined && step && !lit[h]!.some(([a, b]) => a === step.from && b === step.to))
      lit[h]!.push([step.from, step.to])
  }
  return {
    steps,
    lit,
    dots,
    lanes,
    bars,
    hits,
    flows,
    zero,
    first,
    scale,
    end,
    loop,
  }
}

// ---- layouts ----

interface Layout {
  width: number
  height: number
  /** Extra room left and right of the drawing, for wires that bend out. */
  pad: number
  boxes: Record<string, Rect>
  ends: Record<string, [End, End]>
  /** The core's hook-group chips per row. */
  chipRows: number
}

const WIDE: Layout = {
  width: 1200,
  height: 520,
  pad: 0,
  chipRows: 1,
  boxes: {
    ws: { x: 150, y: 16, w: 280, h: 62 },
    lockfile: { x: 460, y: 16, w: 280, h: 62 },
    migrate: { x: 770, y: 16, w: 280, h: 62 },
    history: { x: 14, y: 150, w: 240, h: 66 },
    core: { x: 300, y: 124, w: 600, h: 118 },
    ci: { x: 946, y: 110, w: 240, h: 66 },
    reports: { x: 946, y: 200, w: 240, h: 66 },
    relay: { x: 330, y: 300, w: 250, h: 58 },
    cache: { x: 620, y: 300, w: 250, h: 58 },
    slot1: { x: 270, y: 426, w: 200, h: 76 },
    slot2: { x: 500, y: 426, w: 200, h: 76 },
    slot3: { x: 730, y: 426, w: 200, h: 76 },
  },
  ends: {
    ws: [{ side: 'bottom' }, { side: 'top', at: 0.2 }],
    lockfile: [{ side: 'bottom' }, { side: 'top', at: 0.5 }],
    migrate: [{ side: 'bottom' }, { side: 'top', at: 0.8 }],
    history: [{ side: 'right' }, { side: 'left', at: 0.25 }],
    ci: [{ side: 'left' }, { side: 'right', at: 0.2 }],
    reports: [{ side: 'right', at: 0.7 }, { side: 'left' }],
    relay: [
      { side: 'bottom', at: 0.28 },
      { side: 'top', at: 0.5 },
    ],
    cache: [
      { side: 'bottom', at: 0.72 },
      { side: 'top', at: 0.5 },
    ],
    s1: [
      { side: 'bottom', at: 0.2 },
      { side: 'top', at: 0.5 },
    ],
    s2: [
      { side: 'bottom', at: 0.6 },
      { side: 'top', at: 0.25 },
    ],
    s3: [
      { side: 'bottom', at: 0.95 },
      { side: 'top', at: 0.15 },
    ],
    c1: [
      { side: 'top', at: 0.85 },
      { side: 'bottom', at: 0.1 },
    ],
    c2: [
      { side: 'top', at: 0.8 },
      { side: 'bottom', at: 0.3 },
    ],
    c3: [
      { side: 'top', at: 0.6 },
      { side: 'bottom', at: 0.85 },
    ],
  },
}

// A phone: three small boxes over the core, pairs of boxes under it, the relay and
// the cache side by side, the workers last; side wires bend into the margins.
const NARROW: Layout = {
  width: 360,
  height: 596,
  pad: 24,
  chipRows: 2,
  boxes: {
    ws: { x: 0, y: 0, w: 112, h: 66 },
    lockfile: { x: 124, y: 0, w: 112, h: 66 },
    migrate: { x: 248, y: 0, w: 112, h: 66 },
    core: { x: 0, y: 104, w: 360, h: 160 },
    history: { x: 0, y: 302, w: 112, h: 62 },
    ci: { x: 124, y: 302, w: 112, h: 62 },
    reports: { x: 248, y: 302, w: 112, h: 62 },
    relay: { x: 0, y: 400, w: 172, h: 62 },
    cache: { x: 188, y: 400, w: 172, h: 62 },
    slot1: { x: 0, y: 502, w: 112, h: 84 },
    slot2: { x: 124, y: 502, w: 112, h: 84 },
    slot3: { x: 248, y: 502, w: 112, h: 84 },
  },
  ends: {
    ws: [{ side: 'bottom' }, { side: 'top', at: 0.16 }],
    lockfile: [{ side: 'bottom' }, { side: 'top', at: 0.5 }],
    migrate: [{ side: 'bottom' }, { side: 'top', at: 0.84 }],
    history: [{ side: 'top' }, { side: 'bottom', at: 0.16 }],
    ci: [{ side: 'top' }, { side: 'bottom', at: 0.5 }],
    reports: [{ side: 'bottom', at: 0.84 }, { side: 'top' }],
    relay: [
      { side: 'left', at: 0.6 },
      { side: 'left', at: 0.5 },
    ],
    cache: [
      { side: 'right', at: 0.6 },
      { side: 'right', at: 0.5 },
    ],
    s1: [
      { side: 'bottom', at: 0.3 },
      { side: 'top', at: 0.3 },
    ],
    s2: [
      { side: 'bottom', at: 0.75 },
      { side: 'top', at: 0.25 },
    ],
    s3: [
      { side: 'bottom', at: 0.95 },
      { side: 'top', at: 0.2 },
    ],
    c1: [
      { side: 'top', at: 0.8 },
      { side: 'bottom', at: 0.05 },
    ],
    c2: [
      { side: 'top', at: 0.75 },
      { side: 'bottom', at: 0.3 },
    ],
    c3: [
      { side: 'top', at: 0.7 },
      { side: 'bottom', at: 0.8 },
    ],
  },
}

export const LAYOUTS = { wide: WIDE, narrow: NARROW } as const
export type LayoutName = keyof typeof LAYOUTS

const DIR: Record<Side, [number, number]> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
}

function point(r: Rect, e: End): [number, number] {
  const at = e.at ?? 0.5
  switch (e.side) {
    case 'top':
      return [r.x + r.w * at, r.y]
    case 'bottom':
      return [r.x + r.w * at, r.y + r.h]
    case 'left':
      return [r.x, r.y + r.h * at]
    case 'right':
      return [r.x + r.w, r.y + r.h * at]
  }
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/** A wire's path: a cubic curve leaving and entering square to each box. */
export function wirePath(layout: LayoutName, w: Wire): string {
  const L = LAYOUTS[layout]
  const [a, b] = L.ends[w.id]!
  const p = point(L.boxes[w.from]!, a)
  const q = point(L.boxes[w.to]!, b)
  const span = Math.hypot(q[0] - p[0], q[1] - p[1])
  // Wires bending out into a phone's margin stay inside it.
  const k = Math.max(20, Math.min(L.pad > 0 && a.side === b.side ? 22 : 110, span * 0.42))
  const [dx1, dy1] = DIR[a.side]
  const [dx2, dy2] = DIR[b.side]
  return `M${r1(p[0])} ${r1(p[1])} C${r1(p[0] + dx1 * k)} ${r1(p[1] + dy1 * k)} ${r1(q[0] + dx2 * k)} ${r1(q[1] + dy2 * k)} ${r1(q[0])} ${r1(q[1])}`
}

/** The core's padding, the same on every side and between its title and its group chips (M, 2026-11-18). */
export const PAD = 16

/** The core's group chips, laid out under its title. */
export function chips(
  layout: LayoutName,
): { id: string; x: number; y: number; w: number; h: number }[] {
  const L = LAYOUTS[layout]
  const c = L.boxes['core']!
  const rows = L.chipRows
  const perRow = Math.ceil(GROUPS.length / rows)
  const gap = 8
  const inset = PAD
  const w = (c.w - inset * 2 - gap * (perRow - 1)) / perRow
  const h = 34
  const top = c.y + c.h - inset - rows * h - (rows - 1) * gap
  // The chips sit in the pipeline's order, Cache beside Run and Report (M, 2026-11-18).
  const order = ['setup', 'graph', 'schedule', 'cache', 'run', 'report']
  const sorted = [...GROUPS].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  return sorted.map((g, i) => {
    const row = Math.floor(i / perRow)
    const col = i % perRow
    return {
      id: g.id,
      x: r1(c.x + inset + col * (w + gap)),
      y: r1(top + row * (h + gap)),
      w: r1(w),
      h,
    }
  })
}

export const rect = (layout: LayoutName, id: string): Rect => LAYOUTS[layout].boxes[id]!
