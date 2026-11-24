// A string escape (OSC, DCS, SOS, PM, APC) through its terminator, or to the
// line's end when it has none: Bun.stripANSI drops an unterminated one with
// everything after it, so a stray title escape ate the failure reason
// printed below it. An ESC that is not ST ends it too and is left for
// Bun.stripANSI, as a terminal aborts the string there. C1 openers are not
// looked for: output is decoded UTF-8, where an 8-bit C1 byte reads as a
// lone surrogate (raw-utf8.ts), and scanning for them doubled the cost on
// non-Latin-1 text.
// eslint-disable-next-line no-control-regex -- ESC is the point
const STRING_OPENER = /\x1b[\]P_^X]/
// eslint-disable-next-line no-control-regex -- ESC is the point
const STRING_ESCAPE = /\x1b[\]P_^X][^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?/g

/** `text` without terminal escapes, never losing a line to an unterminated one. */
export function stripEscapes(text: string): string {
  // Tested first, after the cheaper ESC search: the replace alone cost half
  // again as much on coloured text, the regex alone 3x on plain text.
  if (text.indexOf('\x1b') === -1 || !STRING_OPENER.test(text)) return Bun.stripANSI(text)
  return Bun.stripANSI(text.replace(STRING_ESCAPE, ''))
}

// Any escape: a CSI, a string escape (to its terminator or its line's end,
// as above), or ESC with its intermediates and final (`ESC c`, `ESC 7`,
// `ESC ( B`); a lone ESC that completes nothing goes too.
const ANY_ESCAPE =
  // eslint-disable-next-line no-control-regex -- ESC is the point
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|[ -/]*[0-~]?)/g
// eslint-disable-next-line no-control-regex -- ESC is the point
const KEPT_ESCAPE = /^\x1b(?:\[[0-9;:]*m|\[[12]K|\[[01]?G|\]8;)/

/**
 * `text` with only its colours (SGR), links (OSC 8) and redraws of its own
 * line (erase line, column 1: `lastRedraw` plays them) left: what a task may
 * show on vx's terminal. A cursor move or screen erase rewrote vx's own
 * lines, and a mode, title or clipboard escape outlived the task.
 */
export function keepStyleEscapes(text: string): string {
  if (text.indexOf('\x1b') === -1) return text
  return text.replace(ANY_ESCAPE, (esc) => (KEPT_ESCAPE.test(esc) ? esc : ''))
}
