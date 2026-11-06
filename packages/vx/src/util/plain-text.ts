// A string escape (OSC, DCS, SOS, PM, APC) through its terminator, or to the
// line's end when it has none: Bun.stripANSI drops an unterminated one with
// everything after it, so a stray title escape ate the failure reason
// printed below it. An ESC that is not ST ends it too and is left for
// Bun.stripANSI, as a terminal aborts the string there. C1 openers are not
// looked for: output is decoded UTF-8, where an 8-bit C1 byte reads as
// U+FFFD, and scanning for them doubled the cost on non-Latin-1 text.
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
