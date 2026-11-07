// The design tokens: every colour, glyph and spacing vx prints. Nothing
// outside src/ui names a hue or writes an escape byte
// (tests/ui-only-output.unsafe.test.ts); a component asks for a style.

/** Whether a stream paints, and how wide it is. */
export interface ColorSupport {
  enabled: boolean
  /** The terminal's width, read live; none off a terminal. Bars and rules fit it. */
  readonly columns?: number | undefined
}

/**
 * A style every component and inline token draws with, by the level of
 * what it marks. Five levels, each one look, brightest first:
 *
 *   1 outcome   how a thing went: a tone (`ok` `warn` `error` `info`,
 *               `aborted`, `notRun`), its glyph and status word bold
 *   2 name      what it is about: a title (`heading`), an id's hues, a
 *               command or path to type (`strong`, `term`), where a
 *               cache answer came from (`local`, `remote`)
 *   3 value     the fact itself: a field's value, a table cell, a
 *               sentence (`value`, a soft light grey: no line of vx
 *               reads plain white)
 *   4 meta      what frames a fact: a label, a unit, a hint, a count
 *               (`muted`, `label`)
 *   5 chrome    rules and separators (`border`)
 *
 * A component picks the level; a plain string takes the level of where it
 * sits (a value in a field, meta in a title's count).
 */
export type Style =
  | 'ok'
  | 'warn'
  | 'error'
  | 'info'
  | 'aborted'
  | 'notRun'
  | 'local'
  | 'remote'
  | 'heading'
  | 'term'
  | 'value'
  | 'muted'
  | 'strong'
  | 'label'
  | 'border'
  | 'plain'

/** How a status went: the four a notice or a status line can be. */
export type Tone = 'ok' | 'warn' | 'error' | 'info'

const HUE: Record<Style, string> = {
  ok: '#22c55e', // green-500
  warn: '#eab308', // yellow-500
  error: '#ef4444', // red-500
  info: '#06b6d4', // cyan-500
  aborted: '#f97316', // orange-500: red's neighbour, not a failure
  notRun: '#a855f7', // purple-500: stopped before it began
  local: '#38bdf8', // sky-400
  remote: '#2563eb', // blue-600
  heading: '#a78bfa', // violet-400: the brand's first stop
  term: '#22d3ee', // cyan-400: a flag, a selector, an example to type
  value: '#cbd5e1', // slate-300: the fact, one step under a name
  muted: '',
  strong: '',
  label: '',
  border: '#6e7681', // a panel's rule: quiet, never a tone
  plain: '',
}

/** A tone's mark: the one glyph a status, a notice or a card opens with. */
export const SYMBOL: Record<Tone, string> = { ok: '✓', warn: '!', error: '✗', info: '›' }

/** Content sits this far in under its section or card head. */
export const INDENT = '  '
/** A field label's column: 8 wide, wider only if a label is. */
export const LABEL_MIN = 8
/** A meter's widest, and the label column beside it (2 indent + 8 label + 2 gap). */
const BAR_MAX = 50
/** The gutter a section's title sits in: a field's label column, a grid row's lead. */
export const GUTTER = 12
/** A title line's width when the terminal's is unknown (a pipe, a CI log): past a task's name. */
export const TABLE_WIDTH = 120
const BAR_LABEL = GUTTER

/**
 * Identity hues for the two halves of a `project#task` id, never a status
 * colour: one name, one hue, in every run, list and row (2026-10-15).
 */
const IDENTITY = [
  '#a78bfa', // violet-400
  '#60a5fa', // blue-400
  '#e879f9', // fuchsia-400
  '#818cf8', // indigo-400
  '#c084fc', // purple-400
  '#93c5fd', // blue-300
  '#f472b6', // pink-400
] as const

/** A name's identity hue: a fold of the name into the palette. */
export function identityHue(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return IDENTITY[h % IDENTITY.length]!
}

/**
 * Standard env precedence:
 *   NO_COLOR non-empty          → off (overrides FORCE_COLOR)
 *   FORCE_COLOR=0 or =false     → off, even on a TTY
 *   FORCE_COLOR any other value → on (the empty string too)
 *   any CI (`onCi`)             → on: a CI log looks like the terminal
 *   else: on iff the stream is a TTY that is not `TERM=dumb`.
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
      : onCi() || (stream.isTTY === true && !dumbTerminal())
  return {
    enabled,
    get columns() {
      return stream.isTTY === true ? stream.columns : undefined
    },
  }
}

/**
 * The variables a CI sets, each on when non-empty and not `0`/`false`:
 * the generic `CI` most set, and the ones of CIs that set no `CI` (Azure
 * Pipelines' `TF_BUILD`, Jenkins' `JENKINS_URL`, TeamCity's
 * `TEAMCITY_VERSION`). A CI log gets the same colours as a terminal; one
 * whose viewer shows raw escapes is turned off with `NO_COLOR`.
 */
const CI_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
] as const

function onCi(): boolean {
  return CI_VARS.some((name) => {
    const v = process.env[name]
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  })
}

/** `TERM=dumb` can neither paint nor move the cursor: vx prints to it as off a terminal. */
export function dumbTerminal(): boolean {
  return process.env['TERM'] === 'dumb'
}

export const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const UNDERLINE = '\x1b[4m'

// Bun.color('red', 'ansi') emits the colour number as a raw byte, so vx
// paints 24-bit. Bun.color is FFI work per call; a run paints the same
// handful of hues thousands of times, so each is converted once.
const ansiCache = new Map<string, string>()
function ansiFor(hex: string): string {
  let v = ansiCache.get(hex)
  if (v === undefined) ansiCache.set(hex, (v = Bun.color(hex, 'ansi-16m') ?? ''))
  return v
}

export interface PaintOptions {
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

/** `text` in a raw hue (an identity, a gradient stop) and modifiers. Inside src/ui only. */
export function paintHex(
  hex: string,
  text: string,
  c: ColorSupport,
  opts: PaintOptions = {},
): string {
  // Empty text paints nothing: an escape pair around no text is bytes and no mark.
  if (!c.enabled || text === '') return text
  let prefix = ''
  if (opts.bold) prefix += BOLD
  if (opts.dim) prefix += DIM
  if (opts.underline) prefix += UNDERLINE
  if (hex) prefix += ansiFor(hex)
  return prefix === '' ? text : `${prefix}${text}${RESET}`
}

// The underline in the rule's grey (SGR 58): a terminal without it underlines in the text's colour.
const UNDER_RULE = `${UNDERLINE}\x1b[58;2;110;118;129m`

/** A title line underlined end to end, gaps included, each hue kept. */
export function underlined(line: string, c: ColorSupport): string {
  if (!c.enabled) return line.trimEnd()
  // A trailing reset is the line's own end: re-opening the underline there left an empty pair.
  const body = line.endsWith(RESET) ? line.slice(0, -RESET.length) : line
  return `${UNDER_RULE}${body.replaceAll(RESET, RESET + UNDER_RULE)}${RESET}`
}

/** `text` in a style; `bold` adds weight to a hue. */
export function paint(style: Style, text: string, c: ColorSupport, bold = false): string {
  switch (style) {
    case 'plain':
      return text
    case 'muted':
      return paintHex('', text, c, { dim: true })
    case 'strong':
      return paintHex('', text, c, { bold: true })
    case 'heading':
      return paintHex(HUE.heading, text, c, { bold: true })
    case 'label':
      return paintHex('', text, c, { dim: true, underline: true })
    default:
      return paintHex(HUE[style], text, c, bold ? { bold: true } : {})
  }
}

/** A meter's cells: 50, or fewer so the bar fits a narrower terminal. */
export function barWidth(c: ColorSupport): number {
  const columns = c.columns
  return columns === undefined ? BAR_MAX : Math.max(10, Math.min(BAR_MAX, columns - BAR_LABEL))
}

/** A rule's width: flush with the bars beside their labels. */
export function ruleWidth(c: ColorSupport): number {
  return BAR_LABEL + barWidth(c)
}
