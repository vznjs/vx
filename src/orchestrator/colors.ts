// Tiny color helper — gates Bun.color through a `ColorSupport` token
// so the formatters stay pure. The token is computed once at logger
// construction; tests pass `{ enabled: false }` so assertions match
// plain strings.
//
// Bun.color('red', 'ansi') is broken in current Bun versions (emits
// the color number as a raw byte instead of decimal text), so we use
// 'ansi-16m' which emits 24-bit truecolor sequences. Every modern
// terminal supports them, and the `tput colors`-style downgrade isn't
// worth the complexity for our handful of UI accents.

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

export interface ColorSupport {
  enabled: boolean
}

export interface PaintOptions {
  bold?: boolean
  dim?: boolean
}

/**
 * Standard env precedence:
 *   NO_COLOR=anything   → off (overrides FORCE_COLOR)
 *   FORCE_COLOR=anything → on
 *   else: on iff stdout is a TTY.
 */
export function detectColors(stream: NodeJS.WriteStream = process.stdout): ColorSupport {
  if (process.env['NO_COLOR']) return { enabled: false }
  if (process.env['FORCE_COLOR']) return { enabled: true }
  return { enabled: stream.isTTY === true }
}

export function paint(
  color: string,
  text: string,
  colors: ColorSupport,
  opts: PaintOptions = {},
): string {
  if (!colors.enabled) return text
  let prefix = ''
  if (opts.bold) prefix += BOLD
  if (opts.dim) prefix += DIM
  if (color) prefix += Bun.color(color, 'ansi-16m') ?? ''
  if (prefix.length === 0) return text
  return `${prefix}${text}${RESET}`
}
