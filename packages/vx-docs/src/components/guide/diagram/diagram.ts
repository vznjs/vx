// A Guide picture as data: boxes, arrows between them, loose notes and
// dashed frames around groups, in a viewBox about 600 × 260. Each chapter
// keeps its pictures in `src/components/guide/<chapter>/pictures.ts` as
// values of `Picture`; `Diagram.astro` draws any of them, and the chapter's
// rows read the same values, so a picture is held to what the chapter says
// it shows. The look (fonts, strokes, colours) is `diagram.css` alone.

export type Point = [x: number, y: number]

/** What a shape is saying: the one the text is about (accent), a result
 *  that is right (ok) or wrong (danger), something skipped or absent
 *  (muted), a read (link), a warning (warn). */
export type Tone = 'default' | 'accent' | 'link' | 'danger' | 'ok' | 'warn' | 'muted'

export interface Box {
  id: string
  /** Top-left corner. */
  x: number
  y: number
  /** Defaults: 130 × 52, or 60 high with a `sub` line. */
  w?: number
  h?: number
  label: string
  /** A second, quieter line: a command, a status. */
  sub?: string
  tone?: Tone
  /** Read on hover, for a box too narrow to print its label. */
  title?: string
}

export interface Arrow {
  from: string
  to: string
  label?: string
  tone?: Tone
  dashed?: boolean
  /** Corners the arrow passes through, in order. */
  via?: Point[]
}

export interface Note {
  x: number
  y: number
  text: string
  /** Default `muted`. */
  tone?: Tone
  anchor?: 'start' | 'middle' | 'end'
}

/** A dashed frame around a group of boxes, titled at its top left. */
export interface Frame {
  x: number
  y: number
  w: number
  h: number
  label: string
  tone?: Tone
}

export interface Picture {
  /** Unique on its page: it names the SVG's arrowheads and the chapter's rows. */
  name: string
  /** What the picture shows, for a reader who cannot see it. */
  label: string
  caption: string
  width?: number
  height?: number
  boxes: Box[]
  arrows?: Arrow[]
  notes?: Note[]
  frames?: Frame[]
}

const BOX = { w: 130, h: 52, hSub: 60 }

/** The type sizes `diagram.css` sets, in the picture's own units. */
export const FONT = { label: 15, sub: 13, note: 14, arrow: 13, frame: 13 }

/** A string's width in the diagram's mono face (IBM Plex Mono advances 0.6em). */
export function textWidth(text: string, size: number): number {
  return [...text].length * size * 0.6
}

export function boxSize(b: Box): { w: number; h: number } {
  return { w: b.w ?? BOX.w, h: b.h ?? (b.sub === undefined ? BOX.h : BOX.hSub) }
}

/** An arrow as drawn: its path, where its label sits, and the length of
 *  the stretch the label sits on. */
export interface Route {
  d: string
  lx: number
  ly: number
  anchor: 'middle' | 'start'
  /** The labelled stretch runs across (so the label must fit along it). */
  across: boolean
  span: number
}

export function route(p: Picture, a: Arrow): Route {
  const rect = (id: string) => {
    const b = p.boxes.find((x) => x.id === id)
    if (b === undefined) throw new Error(`<Diagram name="${p.name}">: an arrow names no box ${id}`)
    return { x: b.x, y: b.y, ...boxSize(b) }
  }
  const center = (id: string): Point => {
    const r = rect(id)
    return [r.x + r.w / 2, r.y + r.h / 2]
  }
  // Where the ray from a box's centre towards `to` leaves the box, plus a
  // gap so the arrowhead stops short of the border.
  const exit = (id: string, to: Point, gap: number): Point => {
    const r = rect(id)
    const [cx, cy] = center(id)
    const dx = to[0] - cx
    const dy = to[1] - cy
    const t = Math.min(
      dx === 0 ? Infinity : r.w / 2 / Math.abs(dx),
      dy === 0 ? Infinity : r.h / 2 / Math.abs(dy),
    )
    const len = Math.hypot(dx, dy)
    return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap]
  }
  const via = a.via ?? []
  const start = exit(a.from, via[0] ?? center(a.to), 3)
  const end = exit(a.to, via.at(-1) ?? center(a.from), 5)
  const points = [start, ...via, end]
  const mid = Math.floor((points.length - 1) / 2)
  const [s, e] = [points[mid]!, points[mid + 1]!]
  const across = Math.abs(e[0] - s[0]) >= Math.abs(e[1] - s[1])
  return {
    d: points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
    lx: (s[0] + e[0]) / 2 + (across ? 0 : 8),
    ly: (s[1] + e[1]) / 2 + (across ? -9 : 4),
    anchor: across ? 'middle' : 'start',
    across,
    span: Math.hypot(e[0] - s[0], e[1] - s[1]),
  }
}

export interface Lane {
  name: string
  bars: {
    start: number
    end: number
    label: string
    sub?: string
    tone?: Tone
    /** The box's id; by default `<lane name>/<index>`. */
    id?: string
    title?: string
  }[]
}

/**
 * Timelines as boxes: one row per lane, one box per bar, `scale` units of
 * width per unit of time, the lane's name to the left of its row. A bar too
 * narrow for its label prints none (give it a `title`), and one too narrow
 * for its sub line drops the sub.
 */
export function lanes(
  rows: Lane[],
  at: { x: number; y: number; scale: number; row: number; h?: number },
): { boxes: Box[]; notes: Note[] } {
  const h = at.h ?? 40
  const boxes: Box[] = []
  const notes: Note[] = []
  rows.forEach((lane, i) => {
    const y = at.y + i * at.row
    notes.push({ x: at.x - 10, y: y + h / 2 + 5, text: lane.name, anchor: 'end' })
    lane.bars.forEach((bar, j) => {
      const w = (bar.end - bar.start) * at.scale - 3
      const fits = (s: string, size: number): boolean => textWidth(s, size) + 6 <= w
      const labelFits = fits(bar.label, FONT.label)
      boxes.push({
        id: bar.id ?? `${lane.name}/${j}`,
        x: at.x + bar.start * at.scale,
        y,
        w,
        h,
        label: labelFits ? bar.label : '',
        ...(bar.sub !== undefined && labelFits && fits(bar.sub, FONT.sub) ? { sub: bar.sub } : {}),
        ...(bar.tone === undefined ? {} : { tone: bar.tone }),
        ...(bar.title === undefined ? {} : { title: bar.title }),
      })
    })
  })
  return { boxes, notes }
}
