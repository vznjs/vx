// The arithmetic the diagram kit shares: where an edge leaves a box, and the
// triangle that ends an arrow. The head is a polygon, not an SVG <marker>,
// because a marker needs a page-unique id and a chapter may draw several
// diagrams.

export type Variant = 'default' | 'accent' | 'danger' | 'muted' | 'dashed'

export interface Point {
  x: number
  y: number
}

/** IBM Plex Mono's advance is 0.6em; a label's width at `size` px, estimated. */
export function textWidth(text: string, size: number): number {
  return text.length * size * 0.6
}

/** Where the ray from a box's centre towards `toward` crosses the box's edge. */
export function boxEdge(center: Point, w: number, h: number, toward: Point): Point {
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  if (dx === 0 && dy === 0) return center
  const scale = Math.min(
    dx === 0 ? Infinity : w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : h / 2 / Math.abs(dy),
  )
  return { x: center.x + dx * scale, y: center.y + dy * scale }
}

/** An arrow from `from` to `to`: where the shaft stops, and the head's points. */
export function arrow(from: Point, to: Point, size = 8): { shaftEnd: Point; head: string } {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  const ux = (to.x - from.x) / len
  const uy = (to.y - from.y) / len
  const base = { x: to.x - ux * size, y: to.y - uy * size }
  const half = size * 0.55
  const left = { x: base.x - uy * half, y: base.y + ux * half }
  const right = { x: base.x + uy * half, y: base.y - ux * half }
  const pts = [to, left, right].map((p) => `${round(p.x)},${round(p.y)}`).join(' ')
  return { shaftEnd: base, head: pts }
}

export function round(n: number): number {
  return Math.round(n * 10) / 10
}
