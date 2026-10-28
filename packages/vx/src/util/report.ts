import { paint, type ColorSupport } from './colors.js'

// Brand gradient for the rule: identity violet → pink (the project /
// task hues), faded across the dash run. Plain dashes when colors
// are off.
const GRADIENT_FROM = [0xa7, 0x8b, 0xfa] as const
const GRADIENT_TO = [0xf4, 0x72, 0xb6] as const
// The bars' label column: 2 indent + 8 label + 2 gap.
const LABEL = 12

/** A meter's cells: 50, or fewer so the bar fits a narrower terminal. */
export function barWidth(colors: ColorSupport): number {
  const columns = colors.columns
  return columns === undefined ? 50 : Math.max(10, Math.min(50, columns - LABEL))
}

/** A rule's width, flush with the bars: the footer's and a task frame's section rules. */
export function ruleWidth(colors: ColorSupport): number {
  return LABEL + barWidth(colors)
}

/** `─ <mark> ` + dashes, flush with the bars. Shared by the run summary and every report. */
export function gradientRule(colors: ColorSupport, mark = 'vx'): string {
  const head = `─ `
  const width = ruleWidth(colors)
  const dashes = '─'.repeat(Math.max(8, width - 3 - mark.length))
  if (!colors.enabled) return `${head}${mark} ${dashes}`
  const chunks = 8
  // The gradient spans the rule as if its mark were `vx`.
  const per = Math.ceil((width - 5) / chunks)
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
