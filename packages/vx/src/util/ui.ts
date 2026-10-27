// vx's output components (org/devex/log-design.md). A verb or a plugin
// composes these instead of writing raw lines: each component owns its
// color, indent and spacing, so every surface shares one look. Colors
// are decided at print time, per stream.

import {
  detectColors,
  ERROR,
  identityColor,
  paint,
  SUCCESS,
  WARN,
  type ColorSupport,
} from './colors.js'
import { gradientRule } from './report.js'

export type Tone = 'ok' | 'warn' | 'error' | 'info'

const INFO = '#06b6d4'
const HUE: Record<Tone, string> = { ok: SUCCESS, warn: WARN, error: ERROR, info: INFO }
const SYMBOL: Record<Tone, string> = { ok: '✓', warn: '!', error: '✗', info: '›' }
const INDENT = '  '
const LABEL_MIN = 8

type Style = Tone | 'dim' | 'bold' | 'id'

/** Styled text inside a component: a plain string, a token, or a run of them. */
export type Inline = string | { readonly style: Style; readonly text: string } | readonly Inline[]

/** A laid-out piece of output; `render` and `print` space blocks apart. */
export interface Block {
  readonly lines: (colors: ColorSupport) => string[]
}

/** A `project` or `project#task` id, each half in its name's hue, the `#` dim. */
export const id = (text: string): Inline => ({ style: 'id', text })
/** A path, glob or file: bold. */
export const path = (text: string): Inline => ({ style: 'bold', text })
/** A command to type: bold. */
export const cmd = (text: string): Inline => ({ style: 'bold', text })
/** A secondary fact. */
export const dim = (text: string): Inline => ({ style: 'dim', text })
/** Where a task runs (`small#1`): its name's hue in every row and block; `local` plain. */
export const place = (text: string): Inline => (text === 'local' ? text : id(text))
/** Text in a tone's color. */
export const tone = (t: Tone, text: string): Inline => ({ style: t, text })

/** One inline as text, colored for `c`. */
export function inline(x: Inline, c: ColorSupport): string {
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return (x as readonly Inline[]).map((p) => inline(p, c)).join('')
  const { style, text } = x as { style: Style; text: string }
  switch (style) {
    case 'dim':
      return paint('', text, c, { dim: true })
    case 'bold':
      return paint('', text, c, { bold: true })
    case 'id': {
      const hash = text.lastIndexOf('#')
      if (hash < 0) return paint(identityColor(text), text, c)
      const task = text.slice(hash + 1)
      return (
        paint(identityColor(text.slice(0, hash)), text.slice(0, hash), c) +
        paint('', '#', c, { dim: true }) +
        paint(identityColor(task), task, c)
      )
    }
    default:
      return paint(HUE[style], text, c)
  }
}

const block = (lines: (c: ColorSupport) => string[]): Block => ({ lines })
const lines = (x: Inline, c: ColorSupport): string[] => inline(x, c).split('\n')
const visible = (s: string): number => Bun.stringWidth(s)

/** `✗ vx lock  lock not written`: the tone's symbol, the bold verb, the headline. */
export function status(t: Tone, verb: string, headline: Inline): Block {
  return block((c) => [
    `${paint(HUE[t], SYMBOL[t], c)} ${paint('', verb, c, { bold: true })}  ${inline(headline, c)}`,
  ])
}

/**
 * A line vx says mid-run (`[vx] cache save failed: …`, `vx watch: …`), its
 * words as they always read and its tag in the tone's hue; a line with no
 * tag is painted whole. One string, no newline: the run's own streams write it.
 */
export function tagged(t: Tone, line: string, c: ColorSupport): string {
  const body = line.replace(/\n+$/, '')
  const tag = /^(?:\[vx\]|vx(?: [a-z][\w-]*){0,2}:|[\w@/.-]+: )/.exec(body)?.[0].trimEnd()
  return tag === undefined
    ? paint(HUE[t], body, c)
    : `${paint(HUE[t], tag, c, { bold: true })}${body.slice(tag.length)}`
}

/** `tagged` on a stream (stderr unless told), colored for it. */
export function say(t: Tone, line: string, stream: 'out' | 'err' = 'err'): void {
  const s = stream === 'out' ? process.stdout : process.stderr
  s.write(`${tagged(t, line, detectColors(s))}\n`)
}

/**
 * A file or excerpt shown whole (`vx init --dry`, `vx docs`): its title rule
 * bold, its body behind a dim gutter. Uncolored it is the bare text, so a
 * pipe gets the bytes it would copy.
 */
export function excerpt(title: string, body: string): Block {
  return block((c) => {
    if (!c.enabled) return [`── ${title} ──`, ...body.split('\n')]
    const gutter = paint(INFO, '│', c, { dim: true })
    return [
      paint(INFO, `── ${title} ──`, c, { bold: true }),
      ...body
        .split('\n')
        .map((l, i, all) => (i === all.length - 1 && l === '' ? l : `${gutter} ${l}`)),
    ]
  })
}

/** Indented short lines: what is wrong, or what happened. */
export function text(...items: Inline[]): Block {
  return block((c) =>
    items.flatMap((i) =>
      lines(typeof i === 'string' ? prose(i) : i, c).map((l) => `${INDENT}${l}`),
    ),
  )
}

/** Plain words dim, each `command` in them bold: no line of vx reads plain white. */
function prose(text: string): Inline {
  return text.split(/(`[^`\n]+`)/).map((p, i) => (i % 2 === 1 ? cmd(p) : p === '' ? p : dim(p)))
}

/** An indented dim line: why it matters. */
export function why(line: Inline): Block {
  return block((c) => lines(line, c).map((l) => `${INDENT}${paint('', l, c, { dim: true })}`))
}

/** A label and its values; values after the first sit under it. `null` is a blank line. */
export type FieldRow = readonly [label: string, ...values: Inline[]] | null

/** A dim label column with the values aligned beside it; `next` and `fix` are bold. */
export function fields(rows: readonly FieldRow[]): Block {
  return block((c) => {
    const width = Math.max(LABEL_MIN, ...rows.map((r) => (r === null ? 0 : r[0].length)))
    const out: string[] = []
    for (const row of rows) {
      if (row === null) {
        out.push('')
        continue
      }
      const [label, ...values] = row
      const strong = label === 'next' || label === 'fix'
      values
        .flatMap((v) => lines(v, c))
        .forEach((v, i) => {
          const head =
            i === 0 ? paint('', label.padEnd(width), c, { dim: true }) : ' '.repeat(width)
          const value = strong ? paint('', v, c, { bold: true }) : v
          out.push(`${INDENT}${head}  ${value}`.trimEnd())
        })
    }
    return out
  })
}

/** `fix  <action>`: what to do about it. */
export function fix(action: Inline): Block {
  return labelled('fix', action)
}

/** `next  <command>`: the command to type next. */
export function next(command: Inline): Block {
  return labelled('next', command)
}

function labelled(label: string, value: Inline): Block {
  return block((c) => [
    `${INDENT}${paint('', label, c, { dim: true })}  ${paint('', inline(value, c), c, { bold: true })}`,
  ])
}

/** A report: a blank line, the brand rule naming `mark`, then its fields. */
export function report(mark: string, rows: readonly FieldRow[]): Block {
  return block((c) => ['', gradientRule(c, mark), ...fields(rows).lines(c)])
}

/** Aligned columns under a dim header. */
export function table(columns: readonly string[], rows: readonly (readonly Inline[])[]): Block {
  return block((c) => {
    const cells = rows.map((r) => r.map((x) => inline(x, c)))
    const widths = columns.map((h, i) =>
      Math.max(h.length, ...cells.map((r) => visible(r[i] ?? ''))),
    )
    const pad = (s: string, i: number): string =>
      i === columns.length - 1 ? s : s + ' '.repeat(widths[i]! - visible(s))
    return [
      `${INDENT}${paint('', columns.map((h, i) => pad(h, i)).join('  '), c, { dim: true })}`.trimEnd(),
      ...cells.map((r) => `${INDENT}${r.map(pad).join('  ')}`.trimEnd()),
    ]
  })
}

/** A source frame (`> 1 | …` and its caret), indented. */
export function code(frame: string): Block {
  return block(() => frame.split('\n').map((l) => (l === '' ? '' : `${INDENT}${l}`)))
}

export interface NoticeParts {
  tone: Tone
  verb: string
  headline: Inline
  /** What is wrong, one fact a line. */
  what?: readonly Inline[]
  why?: Inline
  /** A source frame, below the facts. */
  code?: string
  fix?: Inline
}

/** A refusal or a warning: status, then what and why, the frame, and the fix, a blank line apart. */
export function notice(p: NoticeParts): Block {
  return block((c) => {
    const parts: Block[] = [status(p.tone, p.verb, p.headline)]
    const body = [
      ...(p.what !== undefined ? [text(...p.what)] : []),
      ...(p.why !== undefined ? [why(p.why)] : []),
    ]
    if (body.length > 0) parts.push(block((cc) => body.flatMap((b) => b.lines(cc))))
    if (p.code !== undefined) parts.push(code(p.code))
    if (p.fix !== undefined) parts.push(fix(p.fix))
    return parts.flatMap((b, i) => (i === 0 ? b.lines(c) : ['', ...b.lines(c)]))
  })
}

/** The blocks as text, a blank line apart, ending in a newline. */
export function render(blocks: readonly Block[], colors: ColorSupport): string {
  return `${blocks.map((b) => b.lines(colors).join('\n')).join('\n\n')}\n`
}

/** Write the blocks to stdout (`out`) or stderr (`err`), colored for that stream. */
export function print(stream: 'out' | 'err', ...blocks: Block[]): void {
  const s = stream === 'out' ? process.stdout : process.stderr
  s.write(render(blocks, detectColors(s)))
}
