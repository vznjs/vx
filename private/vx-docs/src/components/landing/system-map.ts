// The landing's system map: every piece a vx run talks to, as boxes joined
// by wires, and the seven steps of one CI run that light them in turn.
// Two layouts (wide, and a phone's), one set of wires; SystemMap.astro
// draws both and plays the steps. tests/landing.test.ts holds the story.

export type Tone = 'core' | 'read' | 'remote' | 'dte' | 'report'
type Side = 'top' | 'bottom' | 'left' | 'right'

export interface Box {
  id: string
  label: string
  /** The package that brings it, or what it is. */
  sub: string
  tone: Tone
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

export interface Step {
  id: string
  /** The anchor old links land on, where one does. */
  anchor?: string
  title: string
  /** One sentence, backticks as code. */
  line: string
  tone: Tone
  /** Boxes lit during the step. */
  boxes: string[]
  /** The core's stages lit during the step. */
  stages: string[]
  /** Wires a packet travels, `-` first to travel against the wire. */
  wires: string[]
}

export const STAGES = ['lock', 'graph', 'key', 'schedule', 'run', 'cache', 'report'] as const

export const BOXES: Box[] = [
  { id: 'core', label: 'vx', sub: 'one run, every stage', tone: 'core' },
  { id: 'ws', label: 'Your workspace', sub: 'vx.config.ts · .vx/workspace.ts', tone: 'read' },
  { id: 'lockfile', label: 'Lockfile', sub: 'vx-lockfile · pnpm, bun, npm, yarn', tone: 'read' },
  { id: 'history', label: 'History server', sub: 'vx-history · task timings', tone: 'read' },
  { id: 'reapi', label: 'Bazel REAPI', sub: 'vx-reapi · cache and execution', tone: 'remote' },
  {
    id: 'migrate',
    label: 'Turbo or Nx cache',
    sub: 'vx-migrate · keep your remote',
    tone: 'remote',
  },
  { id: 'cache', label: 'Cache server', sub: 'vx-cache · S3, R2 or Docker', tone: 'remote' },
  { id: 'otel', label: 'OpenTelemetry', sub: 'vx-otel · traces, metrics, logs', tone: 'report' },
  { id: 'ci', label: 'GitHub job summary', sub: 'vx-ci · every task on the PR', tone: 'report' },
  { id: 'relay', label: 'Relay', sub: 'vx-dte-server · stores nothing', tone: 'dte' },
  { id: 'w1', label: 'worker', sub: 'CI job', tone: 'dte' },
  { id: 'w2', label: 'worker', sub: 'CI job', tone: 'dte' },
  { id: 'w3', label: 'worker', sub: 'CI job', tone: 'dte' },
  { id: 'w4', label: 'worker', sub: 'CI job', tone: 'dte' },
]

export const WIRES: Wire[] = [
  { id: 'ws', from: 'ws', to: 'core' },
  { id: 'lockfile', from: 'lockfile', to: 'core' },
  { id: 'history', from: 'history', to: 'core' },
  { id: 'reapi', from: 'core', to: 'reapi', dashed: true },
  { id: 'migrate', from: 'core', to: 'migrate', dashed: true },
  { id: 'cache', from: 'core', to: 'cache' },
  { id: 'otel', from: 'core', to: 'otel' },
  { id: 'ci', from: 'core', to: 'ci' },
  { id: 'relay', from: 'core', to: 'relay' },
  { id: 'w1', from: 'relay', to: 'w1' },
  { id: 'w2', from: 'relay', to: 'w2' },
  { id: 'w3', from: 'relay', to: 'w3' },
  { id: 'w4', from: 'relay', to: 'w4' },
  { id: 'store', from: 'w4', to: 'cache' },
]

export const STEPS: Step[] = [
  {
    id: 'lock',
    anchor: 'tasks',
    title: 'Lock',
    line: 'Your configs resolve once into a lock, and every run reads only the lock.',
    tone: 'read',
    boxes: ['ws'],
    stages: ['lock', 'graph'],
    wires: ['ws'],
  },
  {
    id: 'key',
    anchor: 'changed',
    title: 'Key',
    line: 'Each task is keyed on its own files, config and dependencies, so one edit reruns only what it touches.',
    tone: 'read',
    boxes: ['lockfile'],
    stages: ['key'],
    wires: ['lockfile'],
  },
  {
    id: 'schedule',
    anchor: 'parallel',
    title: 'Schedule',
    line: 'Every task’s usual time comes from shared history, so the longest chain starts first.',
    tone: 'read',
    boxes: ['history'],
    stages: ['schedule'],
    wires: ['history'],
  },
  {
    id: 'cache',
    anchor: 'cache',
    title: 'Cache',
    line: 'Your local cache answers first, then your remote, and a hit puts the files back without running anything.',
    tone: 'remote',
    boxes: ['cache', 'reapi', 'migrate'],
    stages: ['cache'],
    wires: ['cache', '-cache', 'reapi', 'migrate'],
  },
  {
    id: 'distribute',
    title: 'Distribute',
    line: 'Whatever is left fans out to workers your own CI starts, through a relay that stores nothing.',
    tone: 'dte',
    boxes: ['relay', 'w1', 'w2', 'w3', 'w4'],
    stages: ['run'],
    wires: ['relay', 'w1', 'w2', 'w3', 'w4'],
  },
  {
    id: 'collect',
    title: 'Collect',
    line: 'Workers push outputs into the cache under each task’s key, and your run pulls them back as its own.',
    tone: 'remote',
    boxes: ['w4', 'cache'],
    stages: ['cache'],
    wires: ['store', '-cache', '-w1', '-w2', '-w3', '-w4', '-relay'],
  },
  {
    id: 'report',
    title: 'Report',
    line: 'Every task lands as a span in OpenTelemetry, a row in your GitHub summary and a line of shared history.',
    tone: 'report',
    boxes: ['otel', 'ci', 'history'],
    stages: ['report'],
    wires: ['otel', 'ci', '-history'],
  },
]

interface Layout {
  width: number
  height: number
  /** Extra room left of x = 0, for wires that bend out. */
  pad: number
  boxes: Record<string, Rect>
  ends: Record<string, [End, End]>
  /** The core's stage chips per row. */
  chipRows: number
}

const WIDE: Layout = {
  width: 1200,
  height: 640,
  pad: 0,
  chipRows: 1,
  boxes: {
    ws: { x: 300, y: 24, w: 260, h: 62 },
    lockfile: { x: 640, y: 24, w: 260, h: 62 },
    history: { x: 30, y: 168, w: 270, h: 66 },
    reapi: { x: 30, y: 276, w: 270, h: 66 },
    migrate: { x: 30, y: 384, w: 270, h: 66 },
    core: { x: 350, y: 172, w: 500, h: 160 },
    otel: { x: 900, y: 168, w: 270, h: 66 },
    ci: { x: 900, y: 262, w: 270, h: 66 },
    cache: { x: 900, y: 470, w: 270, h: 66 },
    relay: { x: 330, y: 436, w: 250, h: 62 },
    w1: { x: 150, y: 562, w: 140, h: 56 },
    w2: { x: 310, y: 562, w: 140, h: 56 },
    w3: { x: 470, y: 562, w: 140, h: 56 },
    w4: { x: 630, y: 562, w: 140, h: 56 },
  },
  ends: {
    ws: [{ side: 'bottom' }, { side: 'top', at: 0.3 }],
    lockfile: [{ side: 'bottom' }, { side: 'top', at: 0.7 }],
    history: [{ side: 'right' }, { side: 'left', at: 0.22 }],
    reapi: [{ side: 'left', at: 0.55 }, { side: 'right' }],
    migrate: [{ side: 'left', at: 0.85 }, { side: 'right' }],
    otel: [{ side: 'right', at: 0.22 }, { side: 'left' }],
    ci: [{ side: 'right', at: 0.5 }, { side: 'left' }],
    cache: [{ side: 'bottom', at: 0.88 }, { side: 'left' }],
    relay: [{ side: 'bottom', at: 0.4 }, { side: 'top' }],
    w1: [{ side: 'bottom', at: 0.2 }, { side: 'top' }],
    w2: [{ side: 'bottom', at: 0.4 }, { side: 'top' }],
    w3: [{ side: 'bottom', at: 0.6 }, { side: 'top' }],
    w4: [{ side: 'bottom', at: 0.8 }, { side: 'top' }],
    store: [{ side: 'right' }, { side: 'bottom' }],
  },
}

// A phone: two columns of boxes around the core, the side wires bending
// out into the margins, the relay's wire down the gap between columns.
const NARROW: Layout = {
  width: 360,
  height: 790,
  pad: 24,
  chipRows: 2,
  boxes: {
    ws: { x: 0, y: 0, w: 172, h: 60 },
    lockfile: { x: 188, y: 0, w: 172, h: 60 },
    core: { x: 0, y: 106, w: 360, h: 160 },
    history: { x: 0, y: 306, w: 172, h: 62 },
    cache: { x: 188, y: 306, w: 172, h: 62 },
    otel: { x: 0, y: 392, w: 172, h: 62 },
    ci: { x: 188, y: 392, w: 172, h: 62 },
    reapi: { x: 0, y: 478, w: 172, h: 62 },
    migrate: { x: 188, y: 478, w: 172, h: 62 },
    relay: { x: 95, y: 590, w: 170, h: 60 },
    w1: { x: 0, y: 710, w: 84, h: 56 },
    w2: { x: 92, y: 710, w: 84, h: 56 },
    w3: { x: 184, y: 710, w: 84, h: 56 },
    w4: { x: 276, y: 710, w: 84, h: 56 },
  },
  ends: {
    ws: [{ side: 'bottom' }, { side: 'top', at: 0.24 }],
    lockfile: [{ side: 'bottom' }, { side: 'top', at: 0.76 }],
    history: [{ side: 'top' }, { side: 'bottom', at: 0.24 }],
    cache: [{ side: 'bottom', at: 0.76 }, { side: 'top' }],
    otel: [{ side: 'left', at: 0.45 }, { side: 'left' }],
    reapi: [{ side: 'left', at: 0.8 }, { side: 'left' }],
    ci: [{ side: 'right', at: 0.45 }, { side: 'right' }],
    migrate: [{ side: 'right', at: 0.8 }, { side: 'right' }],
    relay: [{ side: 'bottom', at: 0.5 }, { side: 'top' }],
    w1: [{ side: 'bottom', at: 0.2 }, { side: 'top' }],
    w2: [{ side: 'bottom', at: 0.4 }, { side: 'top' }],
    w3: [{ side: 'bottom', at: 0.6 }, { side: 'top' }],
    w4: [{ side: 'bottom', at: 0.8 }, { side: 'top' }],
    store: [{ side: 'right' }, { side: 'right', at: 0.7 }],
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
  const k = Math.max(26, Math.min(110, span * 0.42))
  const [dx1, dy1] = DIR[a.side]
  const [dx2, dy2] = DIR[b.side]
  return `M${r1(p[0])} ${r1(p[1])} C${r1(p[0] + dx1 * k)} ${r1(p[1] + dy1 * k)} ${r1(q[0] + dx2 * k)} ${r1(q[1] + dy2 * k)} ${r1(q[0])} ${r1(q[1])}`
}

/** The core's stage chips, laid out in its lower part. */
export function chips(
  layout: LayoutName,
): { id: string; x: number; y: number; w: number; h: number }[] {
  const L = LAYOUTS[layout]
  const c = L.boxes['core']!
  const rows = L.chipRows
  const perRow = Math.ceil(STAGES.length / rows)
  const gap = 8
  const inset = 16
  const w = (c.w - inset * 2 - gap * (perRow - 1)) / perRow
  const h = 28
  const top = c.y + c.h - inset - rows * h - (rows - 1) * gap
  return STAGES.map((id, i) => {
    const row = Math.floor(i / perRow)
    const col = i % perRow
    const inRow = Math.min(perRow, STAGES.length - row * perRow)
    const shift = ((perRow - inRow) * (w + gap)) / 2
    return {
      id,
      x: r1(c.x + inset + shift + col * (w + gap)),
      y: r1(top + row * (h + gap)),
      w: r1(w),
      h,
    }
  })
}

export const rect = (layout: LayoutName, id: string): Rect => LAYOUTS[layout].boxes[id]!
