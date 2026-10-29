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
const UNDERLINE = '\x1b[4m'

// State hues every report shares with the run summary.
export const SUCCESS = '#22c55e'
export const WARN = '#eab308'
export const ERROR = '#ef4444'

export interface ColorSupport {
  enabled: boolean
  /** The terminal's width, read live; none off a terminal. Bars and rules fit it. */
  readonly columns?: number | undefined
}

export interface PaintOptions {
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

/**
 * Standard env precedence:
 *   NO_COLOR non-empty          → off (overrides FORCE_COLOR)
 *   FORCE_COLOR=0 or =false     → off, even on a TTY
 *   FORCE_COLOR any other value → on (the empty string too)
 *   a CI whose log renders ANSI (`ciPaints`) → on
 *   else: on iff stdout is a TTY that is not `TERM=dumb`.
 * `0` and `false` are the convention's "off" (supports-color, chalk,
 * Node); reading every non-empty value as on painted a piped CI log that
 * set `FORCE_COLOR=0` (nx#35292's bug).
 */
export function detectColors(stream: NodeJS.WriteStream = process.stdout): ColorSupport {
  const force = process.env['FORCE_COLOR']
  const enabled = process.env['NO_COLOR']
    ? false
    : force !== undefined
      ? force !== '0' && force !== 'false'
      : ciPaints() || (stream.isTTY === true && !dumbTerminal())
  return {
    enabled,
    get columns() {
      return stream.isTTY === true ? stream.columns : undefined
    },
  }
}

/**
 * A CI whose log viewer renders ANSI colour though the job's output is a
 * pipe (supports-color reads the same variables): its log was plain.
 */
function ciPaints(): boolean {
  const env = process.env
  return (
    env['GITHUB_ACTIONS'] === 'true' ||
    env['GITLAB_CI'] === 'true' ||
    env['BUILDKITE'] === 'true' ||
    env['CIRCLECI'] === 'true'
  )
}

/**
 * `TERM=dumb` (Emacs `M-x shell`, some CI log viewers) can neither paint
 * nor move the cursor: vx prints to it as off a terminal.
 */
export function dumbTerminal(): boolean {
  return process.env['TERM'] === 'dumb'
}

// Bun.color() is pure for a given (hex, mode) pair but does FFI work
// on each call. The framed-output renderer paints the same handful of
// accent colors thousands of times per run; memoizing here turns those
// into hash-map hits.
const ansiCache = new Map<string, string>()
function ansiFor(color: string): string {
  const cached = ansiCache.get(color)
  if (cached !== undefined) return cached
  const v = Bun.color(color, 'ansi-16m') ?? ''
  ansiCache.set(color, v)
  return v
}

export function paint(
  color: string,
  text: string,
  colors: ColorSupport,
  opts: PaintOptions = {},
): string {
  // Empty text paints nothing: an escape pair around no text is bytes and no
  // mark (a full bar's empty remainder).
  if (!colors.enabled || text === '') return text
  let prefix = ''
  if (opts.bold) prefix += BOLD
  if (opts.dim) prefix += DIM
  if (opts.underline) prefix += UNDERLINE
  if (color) prefix += ansiFor(color)
  if (prefix.length === 0) return text
  return `${prefix}${text}${RESET}`
}

/**
 * Identity hues for the two halves of a `project#task` id, never a status
 * colour: one name, one hue, in every run, list and row (2026-10-15:
 * every `#build` matches every other `#build`).
 */
const IDENTITY_PALETTE = [
  '#a78bfa', // violet-400
  '#60a5fa', // blue-400
  '#e879f9', // fuchsia-400
  '#818cf8', // indigo-400
  '#c084fc', // purple-400
  '#93c5fd', // blue-300
  '#f472b6', // pink-400
] as const

/** A project's or a target's hue: a fold of the name into the palette. */
export function identityColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return IDENTITY_PALETTE[h % IDENTITY_PALETTE.length]!
}
