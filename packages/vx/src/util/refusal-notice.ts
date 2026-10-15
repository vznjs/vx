// Every refusal vx prints, as one `ui.notice`: the parts a refusal
// carries, a config refusal's frame, or a plain message laid out a fact a
// line. The flat message stays what `--format json` and logs carry.

import { configRefusal } from './config-frame.js'
import type { RefusalParts } from './errors.js'
import { notice, print, type Block, type Inline, type Tone } from './ui.js'

// A sentence break before a capital, a backtick or a paren: vx joins
// its facts with these.
const BREAK = /(?<=[.?!])\s+(?=[A-Z`(])/
// `(see \`vx run --help\`)`: where to read more.
const SEE = /\s*\(see `([^`]+)`\)/
// `(did you mean --concurrency?)`, `. Did you mean build?`: the fix.
const MEANT = /\s*(?:\(did you mean ([^?]+)\?\)|(?:^|[.;—]\s*)[Dd]id you mean ([^?]+)\?)/

const bare = (s: string): string => s.trim().replace(/[.:]$/, '')

/** A plain message in parts: its first sentence heads, each later one is a line. */
export function messageParts(message: string): RefusalParts {
  const [head = '', ...rest] = message.split('\n')
  let first = head
  const see = SEE.exec(first)
  if (see !== null) first = first.replace(SEE, '')
  const meant = MEANT.exec(first)
  if (meant !== null) first = first.replace(MEANT, '')
  const sentences = first
    .split(BREAK)
    .map(bare)
    .filter((s) => s !== '')
  const [headline = bare(first), ...what] = sentences
  for (const l of rest) {
    if (l.trim() !== '') what.push(...l.replace(/^ {2}/, '').split(BREAK).map(bare))
  }
  const fix = meant !== null ? (meant[1] ?? meant[2])!.trim() : undefined
  return {
    headline,
    ...(what.length > 0 ? { what } : {}),
    ...(see !== null ? { why: `see ${see[1]}` } : {}),
    ...(fix !== undefined ? { fix } : {}),
  }
}

/**
 * `✗ <verb>  <headline>` with what is wrong, why, and the fix under it.
 * `headline` set: that is the status line and the refusal's own headline
 * joins what is wrong (`vx lock  lock not written`).
 */
export function refusalNotice(
  verb: string,
  message: string,
  parts?: RefusalParts,
  opts: { headline?: string; cwd?: string } = {},
): Block {
  const c = parts === undefined ? configRefusal(message, opts.cwd ?? process.cwd()) : undefined
  if (c !== undefined) {
    const what: Inline[] = [{ style: 'bold', text: c.where }, c.problem]
    return notice({
      tone: 'error',
      verb,
      headline: opts.headline ?? 'config refused',
      what,
      ...(c.allowed !== undefined ? { why: `allowed: ${c.allowed}` } : {}),
      code: c.frame,
      ...(c.fix !== undefined ? { fix: c.fix } : {}),
    })
  }
  const p = parts ?? messageParts(message)
  const what = opts.headline !== undefined ? [p.headline, ...(p.what ?? [])] : (p.what ?? [])
  return notice({
    tone: p.tone ?? 'error',
    verb,
    headline: opts.headline ?? p.headline,
    ...(what.length > 0 ? { what } : {}),
    ...(p.why !== undefined ? { why: p.why } : {}),
    ...(p.fix !== undefined ? { fix: p.fix } : {}),
  })
}

/** A message of `tone` from `verb`, a fact a line. */
function messageNotice(tone: Tone, verb: string, message: string): Block {
  const p = messageParts(message)
  return notice({
    tone,
    verb,
    headline: p.headline,
    ...(p.what !== undefined ? { what: p.what } : {}),
    ...(p.why !== undefined ? { why: p.why } : {}),
    ...(p.fix !== undefined ? { fix: p.fix } : {}),
  })
}

/** A line that may open with its verb (`vx why: …`), as `messageNotice` draws it. */
export function lineNotice(tone: Tone, line: string, verb = 'vx'): Block {
  const named = /^(vx(?: [a-z][\w-]*)?): /.exec(line)
  return messageNotice(
    tone,
    named?.[1] ?? verb,
    named === null ? line : line.slice(named[0].length),
  )
}

/** `messageNotice` on stderr. */
export function sayNotice(tone: Tone, verb: string, message: string): void {
  print('err', messageNotice(tone, verb, message))
}

/** `lineNotice` on stderr. */
export function sayLine(tone: Tone, line: string, verb = 'vx'): void {
  print('err', lineNotice(tone, line, verb))
}
