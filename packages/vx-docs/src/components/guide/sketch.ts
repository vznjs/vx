// The data a Guide picture is drawn from (Sketch.astro). A chapter's
// pictures live in `<chapter>/pictures.ts` as values of `Picture`, so the
// chapter renders them and its test reads the same values.

export type Point = [x: number, y: number]

export type Tone = 'default' | 'accent' | 'link' | 'danger' | 'ok' | 'muted'

export interface Box {
  id: string
  /** Top-left corner. */
  x: number
  y: number
  /** Defaults: 130 × 52. */
  w?: number
  h?: number
  label: string
  sub?: string
  tone?: Tone
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
  tone?: 'muted' | 'danger' | 'ok' | 'accent' | 'mono'
  anchor?: 'start' | 'middle' | 'end'
}

/** A dashed frame around a group of boxes, titled at its top left. */
export interface Frame {
  x: number
  y: number
  w: number
  h: number
  label: string
}

export interface Picture {
  /** Unique on its page: it names the SVG's arrowheads. */
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
