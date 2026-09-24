// A Guide picture as data: boxes, arrows between them, and loose notes, in a
// viewBox of about 600×260. Each chapter's pictures live in
// `guide/<chapter>/pictures.ts`, so a chapter's rows can hold what a picture
// shows to the rule it illustrates; `Diagram.astro` draws any of them.

export type Variant = 'default' | 'accent' | 'danger' | 'ok' | 'muted'

export interface Box {
  id: string
  /** Top-left corner. */
  x: number
  y: number
  w: number
  /** Default 44, or 58 with a `sub` line. */
  h?: number
  label: string
  /** A second, smaller line: a command, a status. */
  sub?: string
  variant?: Variant
}

export interface Arrow {
  from: string
  to: string
  label?: string
  variant?: Variant
}

export interface Note {
  x: number
  y: number
  text: string
  variant?: Variant
  anchor?: 'start' | 'middle' | 'end'
}

export interface Picture {
  /** Names the picture for a screen reader and for the chapter's rows. */
  id: string
  label: string
  boxes: Box[]
  arrows?: Arrow[]
  notes?: Note[]
  width?: number
  height?: number
}

export function boxHeight(b: Box): number {
  return b.h ?? (b.sub === undefined ? 44 : 58)
}

/** Where the segment from `b`'s centre towards (tx, ty) leaves `b`, pushed
 *  `gap` further out so an arrowhead does not touch the border. */
export function exitPoint(b: Box, tx: number, ty: number, gap = 4): { x: number; y: number } {
  const h = boxHeight(b)
  const cx = b.x + b.w / 2
  const cy = b.y + h / 2
  const dx = tx - cx
  const dy = ty - cy
  const len = Math.hypot(dx, dy)
  const t = Math.min(
    dx === 0 ? Infinity : b.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : h / 2 / Math.abs(dy),
  )
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap }
}

/** A timeline lane as boxes: one box per bar, `scale` px per unit of time. */
export interface Lane {
  name: string
  bars: { start: number; end: number; label: string; variant?: Variant }[]
}

export function laneBoxes(
  lanes: Lane[],
  at: { x: number; y: number; scale: number; row: number },
): { boxes: Box[]; notes: Note[] } {
  const boxes: Box[] = []
  const notes: Note[] = []
  lanes.forEach((lane, i) => {
    const y = at.y + i * at.row
    notes.push({ x: at.x - 10, y: y + 26, text: lane.name, anchor: 'end' })
    lane.bars.forEach((bar, j) => {
      boxes.push({
        id: `${lane.name}/${j}`,
        x: at.x + bar.start * at.scale,
        y,
        w: (bar.end - bar.start) * at.scale - 3,
        h: 40,
        label: bar.label,
        ...(bar.variant === undefined ? {} : { variant: bar.variant }),
      })
    })
  })
  return { boxes, notes }
}
