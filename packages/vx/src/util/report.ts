import { detectColors, paint, type ColorSupport } from './colors.js'

// Brand gradient for the rule: identity violet → pink (the project /
// task hues), faded across the dash run. Plain dashes when colors
// are off.
const GRADIENT_FROM = [0xa7, 0x8b, 0xfa] as const
const GRADIENT_TO = [0xf4, 0x72, 0xb6] as const
// Rule ends flush with the bars: 2 indent + 8 label + 2 gap + 50 cells.
const RULE_DASHES = 57

/** Total visible rule width: `─ <mark> ` + dashes. Shared by the run summary and every report. */
export function gradientRule(colors: ColorSupport, mark = 'vx'): string {
  const head = `─ `
  const dashes = '─'.repeat(Math.max(8, RULE_DASHES + 2 - mark.length))
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

/** A label and its values, each line after the first under the first; `null` is a blank line. */
export type ReportRow = readonly [label: string, ...values: string[]] | null

/**
 * A verb's report in the run summary's shape: a blank line, the rule,
 * then dim labels in one column with the values aligned beside them.
 * The `next` row, the command to type, is bold.
 */
export function formatReport(
  mark: string,
  rows: readonly ReportRow[],
  colors: ColorSupport = detectColors(),
): string {
  const lines = ['', gradientRule(colors, mark)]
  for (const row of rows) {
    if (row === null) {
      lines.push('')
      continue
    }
    const [label, ...values] = row
    const label8 = paint('', label.padEnd(8), colors, { dim: true })
    values
      .flatMap((v) => v.split('\n'))
      .forEach((v, i) => {
        const value = label === 'next' ? paint('', v, colors, { bold: true }) : v
        lines.push(`  ${i === 0 ? label8 : ' '.repeat(8)}  ${value}`.trimEnd())
      })
  }
  return `${lines.join('\n')}\n`
}
