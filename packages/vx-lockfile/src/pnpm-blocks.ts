// pnpm-lock.yaml's top-level blocks read alone, apart from the parser:
// `discover`'s staleness check asks two of them (`settings`,
// `ignoredOptionalDependencies`) and has no other use for pnpm.ts, whose
// load was ~1.5 ms of every run.

import { record } from './json.js'

/**
 * What the staleness check reads from the file beyond the recorded names:
 * `links` when `settings.excludeLinksFromLockfile` is set, then
 * `ignoredOptionalDependencies`' patterns as `optional:<i>:<pattern>`.
 * Strings, so core memoises them beside the recorded names and a warm
 * `discover` reads no lockfile text; numbered, as core keeps them in a set
 * and a repeated pattern still counts in the matcher's order.
 */
export function stalenessFacts(text: string): string[] {
  const facts = excludesLinks(text) ? ['links'] : []
  const list = topLevel(text, 'ignoredOptionalDependencies')
  if (Array.isArray(list))
    for (const p of list) if (typeof p === 'string') facts.push(`optional:${facts.length}:${p}`)
  return facts
}

/**
 * Whether pnpm drops a manifest's dependency `name` from the install:
 * one of its `optionalDependencies` the lockfile's
 * `ignoredOptionalDependencies` names (pnpm also drops it from
 * `dependencies`, and records it nowhere), matched as `@pnpm/matcher`
 * does: `*` any run, a leading `!` excludes. `patterns`: the list's
 * strings, in order.
 */
export function ignoredOptional(
  patterns: readonly string[],
): (name: string, pkg: Record<string, unknown>) => boolean {
  if (patterns.length === 0) return () => false
  const matchers = patterns.map((p) => {
    const ignore = p.startsWith('!')
    const pattern = ignore ? p.slice(1) : p
    const re = new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`)
    return { ignore, match: (s: string) => re.test(s) }
  })
  const hasInclude = matchers.some((m) => !m.ignore)
  const hasIgnore = matchers.some((m) => m.ignore)
  const matches = (name: string): boolean => {
    if (!hasIgnore) return matchers.some((m) => m.match(name))
    if (!hasInclude) return !matchers.some((m) => m.match(name))
    let matched = false
    for (const m of matchers) {
      if (m.ignore) {
        if (m.match(name)) matched = false
      } else if (!matched && m.match(name)) matched = true
    }
    return matched
  }
  return (name, pkg) => {
    const optional = record(pkg['optionalDependencies'])
    return optional !== undefined && Object.hasOwn(optional, name) && matches(name)
  }
}

/** `settings.excludeLinksFromLockfile`, read from its block alone as `recordedImporters` reads. */
function excludesLinks(text: string): boolean {
  return record(topLevel(text, 'settings'))?.['excludeLinksFromLockfile'] === true
}

/**
 * The last document's top-level `key`, parsed from its block alone (to
 * the next top-level key); undefined where pnpm wrote no such block. A
 * CRLF file (a Windows checkout) heads it `key:\r\n`: found by `\n`
 * alone, the block read as absent though the whole parse has it.
 */
export function topLevel(text: string, key: string): unknown {
  const doc = lastDocument(text)
  // The first line's ending says which: a second scan cost every LF run.
  const head = text.charCodeAt(text.indexOf('\n') - 1) === 13 ? `\n${key}:\r\n` : `\n${key}:\n`
  const at = text.indexOf(head, doc)
  if (at < 0) return undefined
  const block = text.slice(at + 1)
  const end = /\n\S/.exec(block.slice(head.length - 1))
  return record(
    Bun.YAML.parse(end === null ? block : block.slice(0, head.length - 1 + end.index + 1)),
  )?.[key]
}

/**
 * Where the last document starts: the last `\n---`, or 0. Found forward:
 * JSC's `lastIndexOf` walks the text a character at a time, 0.5 ms over
 * vueuse's 680 KB lockfile against 0.05 for `indexOf`, and every run's
 * staleness check asks twice.
 */
function lastDocument(text: string): number {
  let doc = 0
  for (let i = text.indexOf('\n---'); i !== -1; i = text.indexOf('\n---', i + 4)) doc = i
  return doc
}
