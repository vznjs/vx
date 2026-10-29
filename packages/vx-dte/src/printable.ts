// Its own file: github() and gitlab() load with every run's workspace
// config, and importing wire.ts from them loaded the relay client too.

/**
 * `s` with each C0/C1 control and DEL written as `\xNN`: a server's words
 * reach the terminal, and an `ESC ]` or `\r` in them retitled it or
 * overwrote the line before (core's `printable`, L-31).
 */
export const printable = (s: string): string =>
  // oxlint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
