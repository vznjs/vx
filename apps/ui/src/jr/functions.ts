// Named functions for `$computed` expressions in specs. The renderer resolves
// `{ $computed: 'fmtDuration', args: { ms: { $state: '/x' } } }` by calling
// `fmtDuration({ ms: <resolved> })`. This keeps specs pure data and raw values
// in state — formatting lives here, referenced by name.

import { formatBytes, formatCount, formatDate, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

type Args = Record<string, unknown>
const num = (v: unknown) => Number(v)

export const FUNCTIONS: Record<string, (args: Args) => unknown> = {
  fmtDuration: (a) => formatDuration(num(a.ms)),
  fmtBytes: (a) => formatBytes(num(a.b)),
  fmtCount: (a) => formatCount(num(a.n)),
  fmtPercent: (a) => formatPercent(num(a.n), 1),
  fmtPercent0: (a) => formatPercent(num(a.n), 0),
  fmtRelTime: (a) => formatRelativeTime(num(a.t)),
  fmtDate: (a) => formatDate(num(a.t)),
  fmtNumber: (a) => (Number.isFinite(num(a.n)) ? String(Math.round(num(a.n))) : '—'),
  fmtMultiplier: (a) => `${num(a.n).toFixed(2)}×`,
}
