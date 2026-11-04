// A task's own bytes, as a screen shows them: vx never restyles them, but
// it ends a colour they leave on and plays a redraw they hold before its
// own lines go below or beside them.

import { RESET } from './theme.js'

/** Whether `text` holds a terminal escape. */
export const hasEscape = (text: string): boolean => text.includes('\x1b')

/** Whether `text`'s last colour code sets a style rather than resetting it. */
export function leavesStyle(text: string): boolean {
  const at = text.lastIndexOf('\x1b[')
  if (at < 0) return false
  const sgr = /^\[([\d;]*)m/.exec(text.slice(at + 1, at + 64))
  // Not a colour code (a cursor move): look no further, as a reset costs nothing.
  if (sgr === null) return true
  return sgr[1] !== '' && sgr[1] !== '0'
}

/** `text`, with any colour it leaves on ended. */
export const endStyle = (text: string): string => (leavesStyle(text) ? `${text}${RESET}` : text)

/** The bytes that end any colour left on: a task killed mid-write leaves one open. */
export const STYLE_END = RESET

// oxlint-disable-next-line no-control-regex -- ESC is the point
const LINE_RESET = /\r|\x1b\[[12]K|\x1b\[[01]?G/g
// oxlint-disable-next-line no-control-regex -- ESC is the point
const TRAILING_RESETS = /(?:\r|\x1b\[[12]K|\x1b\[[01]?G)+$/
// oxlint-disable-next-line no-control-regex -- ESC is the point
const SGR = /\x1b\[[0-9;]*m/g

/**
 * What a line shows once its redraws have played: the text after its last
 * `\r`, line erase (`CSI 1K`/`2K`) or move to column 1 (`CSI G`), with the
 * colours set before it. Written after an id prefix, a dev server's redraw
 * (`\x1b[2K\x1b[1Gbuilt in 30ms`, a `10%\r100%` progress line) erased or
 * overwrote the prefix on a terminal. A reset that ends the line, as in
 * CRLF, redraws nothing.
 */
export function lastRedraw(line: string): string {
  if (!line.includes('\r') && !line.includes('\x1b')) return line
  const text = line.replace(TRAILING_RESETS, '')
  let cut = -1
  for (const m of text.matchAll(LINE_RESET)) cut = m.index + m[0].length
  if (cut === -1) return text
  return (text.slice(0, cut).match(SGR) ?? []).join('') + text.slice(cut)
}
