// The landing's system map: one box per piece a vx run talks to, the
// core's seven hook groups, and one real run played over them: the 30-task
// workspace of src/data/hero-run.json, as vx-dte's simulator ran it
// (scripts/hero-run.ts). Workers start when the plan needs them, warm up,
// run their tasks and leave when it no longer does; every dot is a message
// that run sent, at its time. Two layouts (wide, and a phone's), one set
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
  /** The anchor old links land on, where one does. */
  anchor?: string
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
  { id: 'history', label: 'History server', sub: 'vx-history · task timings', tone: 'read' },
  { id: 'cache', label: 'Remote cache', sub: 'vx-cache · S3, R2 or Docker', tone: 'remote' },
  { id: 'reports', label: 'Reports', sub: 'vx-otel · vx-ci job summary', tone: 'report' },
  { id: 'relay', label: 'Relay', sub: 'vx-dte-server · stores nothing', tone: 'dte' },
  {
    id: 'workers',
    label: 'Workers',
    sub: 'CI jobs · github(), gitlab(), docker(), local()',
    tone: 'dte',
  },
]

const slotIds = Array.from({ length: SLOTS }, (_, i) => i + 1)

export const WIRES: Wire[] = [
  { id: 'ws', from: 'ws', to: 'core' },
  { id: 'lockfile', from: 'lockfile', to: 'core' },
  { id: 'migrate', from: 'migrate', to: 'core' },
  { id: 'history', from: 'history', to: 'core' },
  { id: 'cache', from: 'core', to: 'cache' },
  { id: 'reports', from: 'core', to: 'reports' },
  { id: 'relay', from: 'core', to: 'relay' },
  { id: 'spawn', from: 'core', to: 'workers', dashed: true },
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
    id: 'projects',
    anchor: 'tasks',
    title: 'Projects',
    hooks: ['discover', 'project', 'fingerprint'],
    line: 'Projects and tasks resolve once, from `vx.config.ts`, a lockfile or a Turbo or Nx graph.',
    tone: 'read',
  },
  {
    id: 'deps',
    anchor: 'changed',
    title: 'Dependencies',
    hooks: ['graph', 'key'],
    line: 'Each task is keyed on its files, config and dependencies, so an edit reruns only what it touches.',
    tone: 'core',
  },
  {
    id: 'schedule',
    anchor: 'parallel',
    title: 'Schedule',
    hooks: ['measures', 'schedule', 'admit'],
    line: 'History times each task: the longest chain goes first, and a worker starts only when the work needs it.',
    tone: 'read',
  },
  {
    id: 'cache',
    anchor: 'cache',
    title: 'Cache',
    hooks: ['cache'],
    line: 'Your local cache answers first, then your remote, and a hit puts the files back without running anything.',
    tone: 'remote',
  },
  {
    id: 'run',
    title: 'Run',
    hooks: ['executor', 'output'],
    line: 'Misses run on workers that start when needed, and each saves its outputs for the run to restore.',
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

/** A message on a wire: it leaves at `at` and arrives `TRAVEL_MS` later. */
export interface Dot {
  at: number
  wire: string
  back: boolean
  tone: Tone
}

/** A worker on its slot. */
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
  /** When each group is lit, [from, to) in play ms. */
  lit: Record<string, [number, number][]>
  dots: Dot[]
  lanes: Lane[]
  bars: Bar[]
  /** Each hit's restore, and the run's clock: play ms of sim ms 0, how many play ms a sim ms takes. */
  hits: number[]
  zero: number
  scale: number
  /** When the run's last task ended, and when the play starts over. */
  end: number
  loop: number
}

export const TRAVEL_MS = 140
/** The whole run, first read to teardown, plays in 5 s (M, 2026-11-18). */
export const PLAY_MS = 5000
/** The steps before any task: each takes well under a second, shown a beat each. */
const BEAT = 200
const HOLD_MS = 1200

/** The run as dots, lanes and bars on one clock, every time from the simulated run. */
export function play(run: Run): Play {
  const dots: Dot[] = []
  const lit: Record<string, [number, number][]> = Object.fromEntries(GROUPS.map((g) => [g.id, []]))
  const dot = (at: number, wire: string, tone: Tone, back = false): void => {
    dots.push({ at, wire, back, tone })
  }
  // Setup reads the workspace's config, Lock the configs, lockfile and graph.
  lit['setup']!.push([0, BEAT])
  dot(0, 'ws', 'read')
  lit['projects']!.push([BEAT, 2 * BEAT])
  for (const w of ['ws', 'lockfile', 'migrate']) dot(BEAT, w, 'read')
  lit['deps']!.push([2 * BEAT, 3 * BEAT])
  // History and the cache's probe answer together, before the first plan.
  dot(3 * BEAT, 'history', 'read')
  dot(3 * BEAT, 'cache', 'remote')
  dot(3 * BEAT + TRAVEL_MS, 'cache', 'remote', true)
  const zero = 3 * BEAT + 2 * TRAVEL_MS
  // One clock for the whole run: every task, warm-up and wait keeps its true share.
  const scale = (PLAY_MS - zero - 3 * TRAVEL_MS) / run.endMs
  const t = (ms: number): number => zero + ms * scale
  const end = t(run.endMs)
  lit['schedule']!.push([3 * BEAT, end])
  lit['cache']!.push([3 * BEAT, end + 3 * TRAVEL_MS])
  lit['run']!.push([zero, end])
  lit['report']!.push([zero, end + 2 * TRAVEL_MS])

  // Each worker takes the first slot free when it starts.
  const free: number[] = []
  const lanes: Lane[] = []
  const slotOf = new Map<string, number>()
  for (const w of [...run.workers].sort((a, b) => a.spawnMs - b.spawnMs)) {
    let slot = free.findIndex((until) => until <= w.spawnMs)
    if (slot < 0) slot = free.length
    if (slot >= SLOTS) throw new Error(`${w.id}: more than ${SLOTS} workers at once`)
    free[slot] = w.leaveMs
    slotOf.set(w.id, slot + 1)
    const join = w.joinMs ?? w.leaveMs
    lanes.push({
      slot: slot + 1,
      cores: w.cores,
      spawn: t(w.spawnMs),
      join: t(join),
      leave: t(w.leaveMs),
    })
    // vx asks CI for it; it joins through the relay; it is let go through the relay.
    dot(t(w.spawnMs), 'spawn', 'dte')
    if (w.joinMs !== null) {
      dot(t(join), `s${slot + 1}`, 'dte', true)
      dot(t(join) + TRAVEL_MS, 'relay', 'dte', true)
    }
    dot(t(w.leaveMs) - 2 * TRAVEL_MS, 'relay', 'dte')
    dot(t(w.leaveMs) - TRAVEL_MS, `s${slot + 1}`, 'dte')
  }

  const byId = new Map(run.tasks.map((x) => [x.id, x]))
  // When a task's inputs are all there: a hit restores then.
  const readyMs = (id: string): number =>
    Math.max(0, ...byId.get(id)!.deps.map((d) => byId.get(d)!.endMs ?? readyMs(d)))
  const hits = run.tasks.filter((x) => x.hit).map((x) => t(readyMs(x.id)))
  for (const at of hits) {
    dot(at, 'cache', 'remote', true)
    dot(at + TRAVEL_MS, 'reports', 'report')
  }

  const bars: Bar[] = []
  const ran = run.tasks
    .filter((x) => !x.hit)
    .sort((a, b) => a.startMs! - b.startMs! || a.id.localeCompare(b.id))
  for (const x of ran) {
    const slot = slotOf.get(x.worker!)!
    const start = t(x.startMs!)
    const stop = t(x.endMs!)
    // Its cores sit at the first gap wide enough among the bars running then.
    const busy = bars
      .filter((b) => b.slot === slot && b.start < stop && b.end > start)
      .sort((a, b) => a.at - b.at)
    let at = 0
    for (const b of busy) if (b.at < at + x.cores! && b.at + b.cores > at) at = b.at + b.cores
    const cores = lanes.find((l) => l.slot === slot && l.spawn <= start && l.leave >= stop)!.cores
    bars.push({
      id: x.id,
      slot,
      at: Math.min(at, Math.max(0, cores - x.cores!)),
      cores: x.cores!,
      start,
      end: stop,
    })
    // The order goes out through the relay; the worker restores the inputs
    // another machine made from the cache, then runs.
    const fetches = x.deps.some((d) => byId.get(d)!.worker !== x.worker)
    const order = start - (fetches ? 3 : 2) * TRAVEL_MS
    dot(order, 'relay', 'dte')
    dot(order + TRAVEL_MS, `s${slot}`, 'dte')
    if (fetches) dot(start - TRAVEL_MS, `c${slot}`, 'remote', true)
    // It ends: its outputs go to the cache under its key, its result to vx
    // through the relay, and vx restores the outputs as its own.
    dot(stop, `c${slot}`, 'remote')
    dot(stop, `s${slot}`, 'dte', true)
    dot(stop + TRAVEL_MS, 'relay', 'dte', true)
    dot(stop + 2 * TRAVEL_MS, 'cache', 'remote', true)
    dot(stop + 2 * TRAVEL_MS, 'reports', 'report')
  }
  // Teardown: the summary is written and the run's timings go back to history.
  dot(end + TRAVEL_MS, 'reports', 'report')
  dot(end + TRAVEL_MS, 'history', 'report', true)
  dots.sort((a, b) => a.at - b.at)
  return { lit, dots, lanes, bars, hits, zero, scale, end, loop: end + 3 * TRAVEL_MS + HOLD_MS }
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
  height: 700,
  pad: 0,
  chipRows: 1,
  boxes: {
    ws: { x: 150, y: 16, w: 280, h: 62 },
    lockfile: { x: 460, y: 16, w: 280, h: 62 },
    migrate: { x: 770, y: 16, w: 280, h: 62 },
    history: { x: 20, y: 196, w: 240, h: 66 },
    core: { x: 280, y: 124, w: 640, h: 196 },
    reports: { x: 940, y: 196, w: 240, h: 66 },
    cache: { x: 940, y: 560, w: 240, h: 66 },
    relay: { x: 300, y: 400, w: 260, h: 58 },
    workers: { x: 20, y: 500, w: 880, h: 176 },
    slot1: { x: 36, y: 552, w: 272, h: 108 },
    slot2: { x: 324, y: 552, w: 272, h: 108 },
    slot3: { x: 612, y: 552, w: 272, h: 108 },
  },
  ends: {
    ws: [{ side: 'bottom' }, { side: 'top', at: 0.2 }],
    lockfile: [{ side: 'bottom' }, { side: 'top', at: 0.5 }],
    migrate: [{ side: 'bottom' }, { side: 'top', at: 0.8 }],
    history: [{ side: 'right' }, { side: 'left', at: 0.3 }],
    reports: [{ side: 'right', at: 0.3 }, { side: 'left' }],
    cache: [{ side: 'right', at: 0.8 }, { side: 'top' }],
    relay: [
      { side: 'bottom', at: 0.2 },
      { side: 'top', at: 0.33 },
    ],
    spawn: [
      { side: 'bottom', at: 0.75 },
      { side: 'top', at: 0.86 },
    ],
    s1: [
      { side: 'bottom', at: 0.2 },
      { side: 'top', at: 0.5 },
    ],
    s2: [
      { side: 'bottom', at: 0.5 },
      { side: 'top', at: 0.5 },
    ],
    s3: [
      { side: 'bottom', at: 0.8 },
      { side: 'top', at: 0.3 },
    ],
    c1: [
      { side: 'bottom', at: 0.8 },
      { side: 'bottom', at: 0.2 },
    ],
    c2: [
      { side: 'bottom', at: 0.8 },
      { side: 'bottom', at: 0.4 },
    ],
    c3: [
      { side: 'bottom', at: 0.8 },
      { side: 'bottom', at: 0.6 },
    ],
  },
}

// A phone: the three sources over the core, the stores and the relay under
// it, the workers stacked last; side wires bend out into the margins.
const NARROW: Layout = {
  width: 360,
  height: 1000,
  pad: 24,
  chipRows: 2,
  boxes: {
    ws: { x: 0, y: 0, w: 112, h: 74 },
    lockfile: { x: 124, y: 0, w: 112, h: 74 },
    migrate: { x: 248, y: 0, w: 112, h: 74 },
    core: { x: 0, y: 116, w: 360, h: 258 },
    history: { x: 0, y: 412, w: 172, h: 62 },
    reports: { x: 188, y: 412, w: 172, h: 62 },
    relay: { x: 0, y: 506, w: 172, h: 62 },
    cache: { x: 188, y: 506, w: 172, h: 62 },
    workers: { x: 0, y: 610, w: 360, h: 384 },
    slot1: { x: 16, y: 660, w: 328, h: 98 },
    slot2: { x: 16, y: 772, w: 328, h: 98 },
    slot3: { x: 16, y: 884, w: 328, h: 98 },
  },
  ends: {
    ws: [{ side: 'bottom' }, { side: 'top', at: 0.16 }],
    lockfile: [{ side: 'bottom' }, { side: 'top', at: 0.5 }],
    migrate: [{ side: 'bottom' }, { side: 'top', at: 0.84 }],
    history: [{ side: 'top' }, { side: 'bottom', at: 0.24 }],
    reports: [{ side: 'bottom', at: 0.76 }, { side: 'top' }],
    relay: [{ side: 'left', at: 0.92 }, { side: 'left' }],
    cache: [{ side: 'right', at: 0.92 }, { side: 'right' }],
    spawn: [
      { side: 'bottom', at: 0.5 },
      { side: 'top', at: 0.5 },
    ],
    s1: [
      { side: 'left', at: 0.7 },
      { side: 'left', at: 0.3 },
    ],
    s2: [
      { side: 'left', at: 0.7 },
      { side: 'left', at: 0.3 },
    ],
    s3: [
      { side: 'left', at: 0.7 },
      { side: 'left', at: 0.3 },
    ],
    c1: [
      { side: 'right', at: 0.7 },
      { side: 'right', at: 0.7 },
    ],
    c2: [
      { side: 'right', at: 0.7 },
      { side: 'right', at: 0.7 },
    ],
    c3: [
      { side: 'right', at: 0.7 },
      { side: 'right', at: 0.7 },
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

/** The core's hook-group chips, laid out in its lower part. */
export function chips(
  layout: LayoutName,
): { id: string; x: number; y: number; w: number; h: number }[] {
  const L = LAYOUTS[layout]
  const c = L.boxes['core']!
  const rows = L.chipRows
  const perRow = Math.ceil(GROUPS.length / rows)
  const gap = 8
  const inset = 14
  const w = (c.w - inset * 2 - gap * (perRow - 1)) / perRow
  const h = layout === 'wide' ? 78 : 72
  const top = c.y + c.h - inset - rows * h - (rows - 1) * gap
  return GROUPS.map((g, i) => {
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
