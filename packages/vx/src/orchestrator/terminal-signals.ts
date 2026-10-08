// Zero-width escapes some terminals act on: a progress bar on the tab or
// taskbar (OSC 9;4) and a desktop notification (OSC 9). Sent only to a
// terminal known to read them: elsewhere OSC 9 IS the notification, so a
// progress update would post "4;1;40" as one.

export interface TerminalSignals {
  progress: boolean
  notify: boolean
}

/** What the terminal `env` names can show; tmux and screen hide it, so they get neither. */
export function terminalSignals(
  env: Readonly<Record<string, string | undefined>>,
): TerminalSignals {
  const program = env['TERM_PROGRAM']
  if (program === 'ghostty') return { progress: true, notify: true }
  // iTerm2 posts OSC 9 since 3.0 and draws OSC 9;4 since 3.6.
  if (program === 'iTerm.app')
    return { progress: atLeast(env['TERM_PROGRAM_VERSION'], 3, 6), notify: true }
  if (program === 'WezTerm') return { progress: false, notify: true }
  // Windows Terminal and ConEmu draw the progress; neither posts OSC 9.
  if (env['WT_SESSION'] !== undefined || env['ConEmuPID'] !== undefined)
    return { progress: true, notify: false }
  return { progress: false, notify: false }
}

function atLeast(version: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '')
  if (m === null) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a > major || (a === major && b >= minor)
}

/** Tab / taskbar progress at `pct` (0–100), or `error` to draw it red. */
export function progressEscape(pct: number, error = false): string {
  return `\x1b]9;4;${error ? 2 : 1};${Math.max(0, Math.min(100, Math.round(pct)))}\x07`
}

export const PROGRESS_CLEAR = '\x1b]9;4;0;0\x07'

/** A desktop notification. BEL and ESC end the sequence, so neither may ride in `text`. */
export function notifyEscape(text: string): string {
  // eslint-disable-next-line no-control-regex -- the control range is the point
  return `\x1b]9;${text.replace(/[\x00-\x1f\x7f]/g, ' ')}\x07`
}
