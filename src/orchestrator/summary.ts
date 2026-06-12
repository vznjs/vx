// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/index.js'
import { paint, type ColorSupport } from './colors.js'
import { tallyOutcomes } from './tally.js'
import { isGroupTask } from '../graph/index.js'

const NO_COLOR: ColorSupport = { enabled: false }

const SUCCESS = '#22c55e'
const WARN = '#eab308'
const ACCENT = '#06b6d4'
const ERROR = '#ef4444'

const BAR_WIDTH = 50
// Brand gradient for the rule: identity violet → pink (the project /
// task hues), faded across the dash run. Plain dashes when colors
// are off.
const GRADIENT_FROM = [0xa7, 0x8b, 0xfa] as const
const GRADIENT_TO = [0xf4, 0x72, 0xb6] as const
// Rule ends flush with the bars: 2 indent + 6 label + 2 gap + 50 cells.
const RULE_DASHES = 55

/** Total visible rule width: `\u2500 <mark> ` + dashes. Shared by summary + header. */
export function gradientRule(colors: ColorSupport, mark = 'vx'): string {
  const head = `\u2500 `
  const dashes = '\u2500'.repeat(Math.max(8, RULE_DASHES + 2 - mark.length))
  if (!colors.enabled) return `${head}${mark} ${dashes}`
  const chunks = 8
  const per = Math.ceil(RULE_DASHES / chunks)
  let out = ''
  for (let i = 0; i < chunks; i++) {
    const seg = dashes.slice(i * per, (i + 1) * per)
    if (seg.length === 0) break
    const f = i / (chunks - 1)
    const hex = `#${GRADIENT_FROM.map((c, j) =>
      Math.round(c + (GRADIENT_TO[j]! - c) * f)
        .toString(16)
        .padStart(2, '0'),
    ).join('')}`
    out += paint(hex, seg, colors)
  }
  return `${paint(`#${GRADIENT_FROM.map((c) => c.toString(16).padStart(2, '0')).join('')}`, head, colors)}${paint('', mark, colors, { bold: true })} ${out}`
}

/**
 * Stacked state meter: one ▰ run per bucket, proportional cells via
 * largest-remainder, every non-zero bucket guaranteed at least one
 * cell. Color carries the state; the color-coded numbers ride beside
 * the bar.
 */
function segmentBar(
  segments: readonly { n: number; color: string }[],
  colors: ColorSupport,
): string {
  const total = segments.reduce((sum, seg) => sum + seg.n, 0)
  if (total === 0) return ''
  const exact = segments.map((seg) => (seg.n / total) * BAR_WIDTH)
  const cells = exact.map(Math.floor)
  let leftover = BAR_WIDTH - cells.reduce((sum, c) => sum + c, 0)
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((x, y) => y.frac - x.frac)
  for (const { i } of order) {
    if (leftover === 0) break
    cells[i]!++
    leftover--
  }
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.n > 0 && cells[i] === 0) {
      const biggest = cells.indexOf(Math.max(...cells))
      cells[biggest]!--
      cells[i] = 1
    }
  }
  return segments.map((seg, i) => paint(seg.color, '\u25b0'.repeat(cells[i]!), colors)).join('')
}

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
): string[] {
  const t = tallyOutcomes(outcomes)
  const hits = t.cachedLocal + t.cachedRemote
  // Skipped tasks never had a shot at the cache; the cache meter
  // covers the tasks that actually resolved.
  const denom = t.total - t.skipped
  const miss = denom - hits

  const dim = (txt: string) => paint('', txt, colors, { dim: true })
  const row = (label: string, value: string): string => `  ${dim(label.padEnd(6))}  ${value}`
  const join = (parts: string[]): string => parts.join(` ${dim('\u00b7')} `)

  // Tasks meter + numbers, live-line order: failed · success · skipped.
  const taskParts: string[] = []
  if (t.failed > 0) taskParts.push(paint(ERROR, `${t.failed} failed`, colors, { bold: true }))
  if (t.successful > 0) taskParts.push(paint(SUCCESS, `${t.successful} success`, colors))
  if (t.skipped > 0) taskParts.push(paint(WARN, `${t.skipped} skipped`, colors))
  const taskBar = segmentBar(
    [
      { n: t.failed, color: ERROR },
      { n: t.successful, color: SUCCESS },
      { n: t.skipped, color: WARN },
    ],
    colors,
  )
  // Bars on the label row, color-coded legend on its own line below,
  // indented to the bar column.
  const legend = (parts: string[]): string => `${' '.repeat(10)}${join(parts)}`
  const lines: string[] = ['', gradientRule(colors)]
  if (taskBar.length > 0) {
    lines.push(row('tasks', taskBar), legend(taskParts))
  } else {
    lines.push(row('tasks', dim('0 tasks')))
  }

  // Cache meter + numbers, live-line order: miss · up-to-date · local
  // · remote.
  if (denom > 0) {
    const cacheBar = segmentBar(
      [
        { n: miss, color: ERROR },
        { n: t.upToDate, color: SUCCESS },
        { n: t.restoredLocal, color: WARN },
        { n: t.restoredRemote, color: ACCENT },
      ],
      colors,
    )
    const cacheParts: string[] = []
    if (miss > 0) cacheParts.push(paint(ERROR, `${miss} miss`, colors))
    if (t.upToDate > 0) cacheParts.push(paint(SUCCESS, `${t.upToDate} up-to-date`, colors))
    if (t.restoredLocal > 0) cacheParts.push(paint(WARN, `${t.restoredLocal} local`, colors))
    if (t.restoredRemote > 0) cacheParts.push(paint(ACCENT, `${t.restoredRemote} remote`, colors))
    lines.push(row('cache', cacheBar), legend(cacheParts))
  }

  // Per-task duration spread (skipped tasks never ran — excluding
  // them keeps min honest). Dim: context, not headline.
  const durations = outcomes
    .filter((o) => o.status !== 'skipped' && !isGroupTask(o.node))
    .map((o) => o.durationMs)
  let spread = ''
  if (durations.length > 0) {
    const max = Math.max(...durations)
    const min = Math.min(...durations)
    const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length
    spread = ` ${dim(`\u00b7 max ${formatDuration(max)} \u00b7 avg ${formatDuration(avg)} \u00b7 min ${formatDuration(min)}`)}`
  }
  lines.push('', row('time', `${formatDuration(totalMs)}${spread}`))
  return lines
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
