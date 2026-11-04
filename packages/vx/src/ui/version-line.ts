// `vx --version`'s one line, imported alone: the answer that loads nothing
// else (the ui barrel costs ~20 ms, `node:tty` 17 ms). Painted as the
// `status` component's verb and the info hue; piped, the same words a
// script reads.

import { fstatSync } from 'node:fs'

function versionLine(version: string, where: string, on: boolean): string {
  const sgr = (code: string, text: string): string => (on ? `\x1b[${code}m${text}\x1b[0m` : text)
  return `${sgr('1', 'vx')} ${sgr('38;2;6;182;212', version)}${where === '' ? '' : sgr('2', where)}\n`
}

/**
 * Write the line to stdout. Colour is decided here, not by `detectColors`:
 * fd 1 as a character device is the TTY answer, and a CI's log is not
 * painted for this one line. `Bun.stdout`, not `process.stdout`: the Node
 * stream's first touch is ~7 ms, half of this verb (2026-10-02). A reader
 * gone (EPIPE) is no failure of the line.
 */
export async function printVersion(version: string, where: string): Promise<void> {
  const env = process.env
  const on = env['NO_COLOR']
    ? false
    : env['FORCE_COLOR'] !== undefined
      ? env['FORCE_COLOR'] !== '0' && env['FORCE_COLOR'] !== 'false'
      : env['TERM'] !== 'dumb' && fstatSync(1).isCharacterDevice()
  await Bun.write(Bun.stdout, versionLine(version, where, on)).catch(() => {})
}
