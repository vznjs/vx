// How a run schedules, as `dte({ scheduler })` names it: loaded with the
// plugin, so it holds only the names and the booking rule.

import type { Need } from './dispatch.js'

/**
 * How a distributed run schedules, one choice per layer, so each can be
 * compared on the same runs (tests/sim.test.ts) and a workspace can pick
 * another (2026-10-23):
 * - `order`, which waiting task goes first: `critical-path` (longest
 *   chain after it, HEFT's rank), `graphene` (the long and the wide
 *   first, then by chain, Grandl OSDI'16), `fifo` (as they got ready);
 * - `place`, which worker takes it: `best-fit` (fewest cores left),
 *   `tetris` (needs most aligned with what is free, SIGCOMM'14),
 *   `worst-fit` (most free), `first-fit`;
 * - `book`, what a task holds: `measured` (its history), `margin`
 *   (history and a fifth more, Borg's), `whole` (a worker each);
 * - `scale`, how many workers: `plan` (the fewest that end the known
 *   work near its best, `planner.ts`), `backlog` (enough cores for what
 *   is ready or running, of each platform, Spark's dynamic allocation).
 */
export interface Strategy {
  readonly order: 'critical-path' | 'graphene' | 'fifo'
  readonly place: 'best-fit' | 'tetris' | 'worst-fit' | 'first-fit'
  readonly book: 'measured' | 'margin' | 'whole'
  readonly scale: 'plan' | 'backlog'
}

export const DEFAULT_STRATEGY: Strategy = {
  order: 'critical-path',
  place: 'best-fit',
  book: 'measured',
  scale: 'plan',
}

/** Every choice of each layer: what `dte({ scheduler })` accepts. */
export const STRATEGIES: { readonly [K in keyof Strategy]: readonly Strategy[K][] } = {
  order: ['critical-path', 'graphene', 'fifo'],
  place: ['best-fit', 'tetris', 'worst-fit', 'first-fit'],
  book: ['measured', 'margin', 'whole'],
  scale: ['plan', 'backlog'],
}

/** `need` as `book` holds it. */
export function booked(need: Need, book: Strategy['book']): Need {
  if (book === 'whole') return { cores: Infinity, memory: Infinity, above: need.above }
  if (book === 'margin' && need.cores !== Infinity && need.ask === undefined)
    return { cores: need.cores * 1.2, memory: need.memory * 1.2, above: need.above }
  return need
}
