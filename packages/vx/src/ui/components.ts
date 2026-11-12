// vx's output components. A verb, the run and every plugin compose these;
// nothing else draws (tests/ui-only-output.unsafe.test.ts). Each owns its
// colour, indent and spacing, decided at print time for the stream it lands
// on, so every surface shares one look. Design: docs/design/ui-2026-11.md.

import {
  barWidth,
  identityHue,
  GUTTER,
  INDENT,
  LABEL_MIN,
  paint,
  paintHex,
  RESET,
  ruleWidth,
  SYMBOL,
  TABLE_WIDTH,
  underlined,
  type ColorSupport,
  type Style,
  type Tone,
} from './theme.js'
import type { Inline, Token } from '../util/index.js'

export type { Inline } from '../util/index.js'

/** A laid-out piece of output; `render` and `print` space blocks apart. */
export interface Block {
  readonly lines: (colors: ColorSupport) => string[]
  /** A grid's column header: it rides its section's title line, past the gutter. */
  readonly head?: (colors: ColorSupport) => string
}

/** A `project` or `project#task` id, each half in its name's hue, the `#` dim. */
export const id = (text: string): Inline => ({ style: 'id', text })
/** A path, glob or file: bold. */
export const path = (text: string): Inline => ({ style: 'strong', text })
/** A command to type: bold. */
export const cmd = (text: string): Inline => ({ style: 'strong', text })
/** What to read first in a line: bold. */
export const strong = (text: string): Inline => ({ style: 'strong', text })
/** A secondary fact. */
export const dim = (text: string): Inline => ({ style: 'muted', text })
/** Where a task runs (`small#1`): its name's hue in every row and block; `local` plain. */
export const place = (text: string): Inline => (text === 'local' ? dim(text) : id(text))
/** Text in a tone's colour, bold if asked. */
export const tone = (t: Style, text: string, bold = false): Inline =>
  bold ? { style: t, text, bold } : { style: t, text }

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * `s` with every control byte but a tab and a line break as `\xNN`: a
 * component quotes paths and names, anyone's bytes, and one holding
 * `ESC ]0;` retitled the terminal. The colours are the components' own.
 */
const plainText = (s: string): string =>
  s.replace(CONTROL, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)

/** An id's two halves, each in its name's hue, the `#` dim. */
function paintId(text: string, c: ColorSupport, bold: boolean): string {
  const opts = bold ? { bold: true } : {}
  const hash = text.lastIndexOf('#')
  if (hash < 0) return paintHex(identityHue(text), text, c, opts)
  const task = text.slice(hash + 1)
  const project = text.slice(0, hash)
  return (
    paintHex(identityHue(project), project, c, opts) +
    paintHex('', '#', c, { dim: true }) +
    paintHex(identityHue(task), task, c, opts)
  )
}

/**
 * `project#task` halves, each in its name's identity hue (never a status
 * colour), the separator dim. `hueSource` is the FULL project name, so a
 * cut display string keeps its hue.
 */
export function idParts(
  hueSource: string,
  projectText: string,
  taskText: string,
  c: ColorSupport,
  opts: { bold?: boolean; sep?: '#' | ':' } = {},
): string {
  // Plain, every half is its text: no hue to fold (a row per task).
  if (!c.enabled) return `${projectText}${opts.sep ?? '#'}${taskText}`
  const style = opts.bold === true ? { bold: true } : {}
  return (
    paintHex(identityHue(hueSource), projectText, c, style) +
    paintHex('', opts.sep ?? '#', c, { dim: true }) +
    paintHex(identityHue(taskText), taskText, c, style)
  )
}

/** One inline as text, coloured for `c`. A bare string is printed as given. */
export function inline(x: Inline, c: ColorSupport): string {
  if (typeof x === 'string') return plainText(x)
  if (Array.isArray(x)) return (x as readonly Inline[]).map((p) => inline(p, c)).join('')
  const t = x as Token
  const text = plainText(t.text)
  return t.style === 'id' ? paintId(text, c, t.bold === true) : paint(t.style, text, c, t.bold)
}

/** The visible width of an inline: its text, never its colour. */
export function width(x: Inline): number {
  if (typeof x === 'string') return Bun.stringWidth(x)
  if (Array.isArray(x)) return (x as readonly Inline[]).reduce<number>((n, p) => n + width(p), 0)
  return Bun.stringWidth((x as Token).text)
}

const block = (lines: (c: ColorSupport) => string[]): Block => ({ lines })
const lines = (x: Inline, c: ColorSupport): string[] => inline(x, c).split('\n')

/** Plain words at the value level, each `command` in them bold. */
function prose(text: string): Inline {
  return text
    .split(/(`[^`\n]+`)/)
    .map((p, i) => (i % 2 === 1 ? cmd(p) : p === '' ? p : { style: 'value' as const, text: p }))
}

// ── Panels ──────────────────────────────────────────────────────────
// vx's screens look like a TUI and are not one: each part is a box drawn
// line by line into the scrollback, so a pipe, a CI log and a terminal all
// read it top to bottom. The box is paint: off colour a panel is its rule
// and its lines, the same bytes a grep or a test reads.

// oxlint-disable-next-line no-control-regex -- an escape is copied whole, never cut
const ESCAPE = /^(?:\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/

/**
 * `line` in rows of `w` visible columns, each padded to `w`. Nothing is
 * cut: a long line wraps at a space where it has one, a continuation sits
 * under the line's value column (past its first two-space gap: a field's
 * value, a table's last cell) so the label column stays clear, and a colour
 * open at a break carries on in the next row.
 */
export function wrap(line: string, w: number): string[] {
  const shown = Bun.stringWidth(line)
  if (shown <= w) return [line + ' '.repeat(w - shown)]
  // Each visible character with the escapes before it and the style open at it.
  const cells: { pre: string; ch: string; cw: number; style: string }[] = []
  let pre = ''
  let style = ''
  for (let i = 0; i < line.length;) {
    if (line.charCodeAt(i) === 0x1b) {
      const m = ESCAPE.exec(line.slice(i, i + 256))
      if (m !== null) {
        pre += m[0]
        if (m[0].endsWith('m')) style = m[0] === RESET ? '' : style + m[0]
        i += m[0].length
        continue
      }
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!)
    cells.push({ pre, ch, cw: Bun.stringWidth(ch), style })
    pre = ''
    i += ch.length
  }
  const plain = cells.map((c) => c.ch).join('')
  const gap = /^ *\S.*? {2,}(?=\S)/.exec(plain)?.[0]
  const lead = /^ */.exec(plain)![0].length
  const hang = Math.min(gap === undefined ? lead : Bun.stringWidth(gap), Math.floor(w / 2))
  const rows: string[] = []
  let at = 0
  let indent = 0
  while (at < cells.length) {
    // The widest run from `at` that fits, ended at a space when there is one.
    let used = indent
    let end = at
    let space = -1
    while (end < cells.length && used + cells[end]!.cw <= w) {
      if (cells[end]!.ch === ' ' && end > at) space = end
      used += cells[end]!.cw
      end++
    }
    if (end < cells.length && space !== -1 && cells[end]!.ch !== ' ') end = space
    if (end === at) end = at + 1
    let row = indent === 0 ? '' : ' '.repeat(indent)
    if (at > 0) row += cells[at]!.style
    let width = indent
    for (let k = at; k < end; k++) {
      row += cells[k]!.pre + cells[k]!.ch
      width += cells[k]!.cw
    }
    const open = end < cells.length ? cells[end]!.style : ''
    if (end >= cells.length) row += pre
    rows.push(`${row}${open === '' ? '' : RESET}${' '.repeat(Math.max(0, w - width))}`)
    at = end
    while (at < cells.length && cells[at]!.ch === ' ') at++
    indent = hang
  }
  return rows
}

/** A title line's width: the terminal's, so a task's name sits over it too; never under the bars'. */
const titleWidth = (c: ColorSupport): number => Math.max(ruleWidth(c), c.columns ?? TABLE_WIDTH)

/**
 * A section's title line: the title in the gutter, bold in the brand hue,
 * a grid's column header past it (`head`), a note flush right, the whole
 * line underlined in the rule's grey. No rule characters: off colour it is
 * the same words, unmarked.
 */
export function panelTop(
  title: string,
  c: ColorSupport,
  count?: Inline,
  note?: Inline,
  head?: string,
): string {
  let line =
    INDENT +
    paint('heading', title, c) +
    (count === undefined ? '' : ` ${inline(typeof count === 'string' ? dim(count) : count, c)}`)
  if (head !== undefined) line += ' '.repeat(Math.max(1, GUTTER - Bun.stringWidth(line))) + head
  const tail = note === undefined ? '' : inline(typeof note === 'string' ? dim(note) : note, c)
  const used = Bun.stringWidth(line) + Bun.stringWidth(tail)
  line += ' '.repeat(Math.max(tail === '' ? 0 : 2, titleWidth(c) - used)) + tail
  return underlined(line, c)
}

/**
 * A list's divider: the underline alone, from the grid's first column to the
 * title lines' end (off colour, a blank line).
 */
export function divider(c: ColorSupport): string {
  if (!c.enabled) return ''
  return ' '.repeat(GUTTER) + underlined(' '.repeat(titleWidth(c) - GUTTER), c)
}

/**
 * A titled part of a screen: `Tasks`, `Warnings`, `Running`, `Summary`,
 * a verb's report. A panel of its blocks, each a blank line apart.
 */
export function section(title: string, ...body: Block[]): Block
export function section(title: string, count: Inline, ...body: Block[]): Block
export function section(title: string, ...rest: (Block | Inline)[]): Block {
  const counted = rest.length > 0 && !isBlock(rest[0])
  const count = counted ? (rest[0] as Inline) : undefined
  const body = (counted ? rest.slice(1) : rest) as Block[]
  return block((c) => {
    const inner = body.flatMap((b, i) => (i === 0 ? b.lines(c) : ['', ...b.lines(c)]))
    return [panelTop(title, c, count, undefined, body[0]?.head?.(c)), ...inner]
  })
}

const isBlock = (x: unknown): x is Block =>
  typeof x === 'object' && x !== null && 'lines' in x && typeof x.lines === 'function'

/** `✗ vx lock lock not written`: the tone's symbol, the bold verb, the headline. */
export function status(t: Tone, verb: string, headline: Inline): Block {
  return block((c) => [
    `${paint(t, SYMBOL[t], c)} ${paint('strong', verb, c)}  ${inline(headline, c)}`,
  ])
}

/**
 * A line vx says mid-run (`[vx] cache save failed: …`, `vx watch: …`), its
 * words as they always read and its tag in the tone's hue; a line with no
 * tag is painted whole. One string, no newline: the run's own streams write it.
 */
export function tagged(t: Tone, line: string, c: ColorSupport): string {
  // A warning carries a remote's or a plugin's words, anyone's bytes.
  const body = plainText(line.replace(/\n+$/, ''))
  const tag = /^(?:\[vx\]|vx(?: [a-z][\w-]*){0,2}:|[\w@/.-]+: )/.exec(body)?.[0].trimEnd()
  return tag === undefined
    ? paint(t, body, c)
    : `${paint(t, tag, c, true)}${paint('muted', body.slice(tag.length), c)}`
}

/**
 * A file or excerpt shown whole (`vx init --dry`, `vx docs`): its title rule
 * bold, its body behind a dim gutter. Uncoloured it is the bare text, so a
 * pipe gets the bytes it would copy.
 */
export function excerpt(title: string, body: string): Block {
  return block((c) => {
    if (!c.enabled) return [`── ${title} ──`, ...body.split('\n')]
    const gutter = paint('info', '│', c)
    return [
      paint('info', `── ${title} ──`, c, true),
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

/** One line at the margin: a verb's answer (`vx 0.0.650`), plain strings dim. */
export function line(...items: Inline[]): Block {
  return block((c) => [items.map((i) => inline(typeof i === 'string' ? prose(i) : i, c)).join('')])
}

/** A blank line: what parts a run's cycles or a reply from what came before. */
export function gap(): Block {
  return block(() => [''])
}

/** An indented dim line: why it matters. */
export function why(line: Inline): Block {
  return block((c) => lines(line, c).map((l) => `${INDENT}${paint('muted', l, c)}`))
}

/** A label and its values; values after the first sit under it. `null` is a blank line. */
export type FieldRow = readonly [label: string, ...values: Inline[]] | null

/** A dim label column with the values aligned beside it; `next` and `fix` are bold. */
export function fields(rows: readonly FieldRow[]): Block {
  return block((c) => {
    const w = Math.max(LABEL_MIN, ...rows.map((r) => (r === null ? 0 : r[0].length)))
    const out: string[] = []
    for (const row of rows) {
      if (row === null) {
        out.push('')
        continue
      }
      const [label, ...values] = row
      const strongRow = label === 'next' || label === 'fix'
      values
        // A command is bold whole, never dim prose under the bold.
        .flatMap((v) => lines(typeof v === 'string' && !strongRow ? prose(v) : v, c))
        .forEach((v, i) => {
          const head = i === 0 ? paint('muted', label.padEnd(w), c) : ' '.repeat(w)
          const value = strongRow ? paint('strong', v, c) : v
          out.push(`${INDENT}${head}  ${value}`.trimEnd())
        })
    }
    return out
  })
}

/** `fix <action>`: what to do about it. */
export function fix(action: Inline): Block {
  return labelled('fix', action)
}

/** `next <command>`: the command to type next. */
export function next(command: Inline): Block {
  return labelled('next', command)
}

function labelled(label: string, value: Inline): Block {
  return block((c) => [
    `${INDENT}${paint('muted', label, c)}  ${paint('strong', inline(value, c), c)}`,
  ])
}

/** A report: a blank line, the section rule naming `title`, then its fields. */
export function report(title: string, rows: readonly FieldRow[]): Block {
  return block((c) => ['', ...section(title, fields(rows)).lines(c)])
}

/** A table column: its header, and `right` for numbers. */
export type Column = string | { readonly title: string; readonly align: 'right' }

/**
 * Aligned columns under a dim header (an empty header line is left out).
 * A plain string cell is dim; the last column is never padded.
 */
export function table(columns: readonly Column[], rows: readonly (readonly Inline[])[]): Block {
  return block((c) => {
    const titles = columns.map((col) => (typeof col === 'string' ? col : col.title))
    const right = columns.map((col) => typeof col !== 'string' && col.align === 'right')
    const cells = rows.map((r) => r.map((x) => inline(typeof x === 'string' ? prose(x) : x, c)))
    const widths = titles.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] === undefined ? 0 : width(r[i]!)))),
    )
    const pad = (s: string, i: number, w: number): string => {
      const gap = ' '.repeat(Math.max(0, widths[i]! - w))
      return right[i] ? gap + s : i === titles.length - 1 ? s : s + gap
    }
    const head = titles.every((t) => t === '')
      ? []
      : [
          `${INDENT}${paint('muted', titles.map((h, i) => pad(h, i, h.length)).join('  '), c)}`.trimEnd(),
        ]
    return [
      ...head,
      ...cells.map((r, ri) =>
        `${INDENT}${r.map((s, i) => pad(s, i, width(rows[ri]![i] ?? ''))).join('  ')}`.trimEnd(),
      ),
    ]
  })
}

/**
 * A debug table vx prints on request (`VX_DEBUG_TIMING=1`): its `[tag]`
 * lines' tag bold in the info hue, every other character dim.
 */
export function trace(lines: readonly string[]): Block {
  return block((c) =>
    lines.map((l) => {
      const tag = /^\[[^\]]+\]/.exec(l)?.[0]
      return tag === undefined
        ? paint('muted', l, c)
        : `${paint('info', tag, c, true)}${paint('muted', l.slice(tag.length), c)}`
    }),
  )
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

/** One part of a meter: how many, in which style, drawn with which cell. */
export interface Segment {
  readonly n: number
  readonly style: Style
  /** `▰` by default; `▱` for what is not done yet. */
  readonly cell?: string
}

/**
 * A stacked meter: one run of cells per segment, proportional by largest
 * remainder, every non-empty segment at least one cell. Style carries the
 * state; the numbers ride beside it in a legend.
 */
export function bar(segments: readonly Segment[], c: ColorSupport): string {
  const total = segments.reduce((sum, seg) => sum + seg.n, 0)
  if (total === 0) return ''
  const w = barWidth(c)
  const exact = segments.map((seg) => (seg.n / total) * w)
  const cells = exact.map(Math.floor)
  let leftover = w - cells.reduce((sum, n) => sum + n, 0)
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
  return segments.map((seg, i) => paint(seg.style, (seg.cell ?? '▰').repeat(cells[i]!), c)).join('')
}

/** A meter of `filled` of `width` cells in `style`, the rest dim. */
export function gauge(filled: number, style: Style, c: ColorSupport): string {
  const w = barWidth(c)
  const n = Math.max(0, Math.min(w, filled))
  return paint(style, '▰'.repeat(n), c) + paint('muted', '▱'.repeat(w - n), c)
}

/** A meter's width, for a caller that scales a count to it. */
export { barWidth }

/** The blocks as text, a blank line apart, ending in a newline. */
export function render(blocks: readonly Block[], colors: ColorSupport): string {
  return `${blocks.map((b) => b.lines(colors).join('\n')).join('\n\n')}\n`
}
