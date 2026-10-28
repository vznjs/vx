// The one line a server prints at start or when it refuses to start,
// painted as vx's own status lines are: a server's log is read beside
// vx's, and plain white read as noise there.

const HUE = { ok: '34;197;94', err: '239;68;68' } as const
const SYMBOL = { ok: '✓', err: '✗' } as const

/** Colour as vx decides it: NO_COLOR, then FORCE_COLOR, then a terminal. */
function paints(stream: { isTTY?: boolean }): boolean {
  const env = process.env
  if (env['NO_COLOR']) return false
  const force = env['FORCE_COLOR']
  if (force !== undefined) return force !== '0' && force !== 'false'
  return stream.isTTY === true && env['TERM'] !== 'dumb'
}

/**
 * `✓ vx-cache-server  listening on http://…` or `✗ vx-cache-server  <why>`.
 * Lines after the first (a usage text) print dim under it.
 */
export function statusLine(
  tone: 'ok' | 'err',
  name: string,
  text: string,
  stream: { isTTY?: boolean } = tone === 'ok' ? process.stdout : process.stderr,
): string {
  const [head = '', ...rest] = text.split('\n')
  if (!paints(stream)) return `${[`${SYMBOL[tone]} ${name}  ${head}`, ...rest].join('\n')}\n`
  const url = head.replace(/(https?:\/\/\S+)/g, '\x1b[38;2;6;182;212m$1\x1b[0m')
  const first = `\x1b[38;2;${HUE[tone]}m${SYMBOL[tone]}\x1b[0m \x1b[1m${name}\x1b[0m  ${url}`
  return `${[first, ...rest.map((l) => (l === '' ? l : `\x1b[2m${l}\x1b[0m`))].join('\n')}\n`
}
