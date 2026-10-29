/**
 * Levenshtein distance, capped: anything at or past `cap` edits reads as
 * `cap` (3 by default: past two edits a hint would guess rather than
 * help). A caller that allows three edits needs a cap of four — under a
 * cap of 3, a candidate nine edits away read as 3 and was offered.
 */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) >= cap) return cap
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return Math.min(prev[b.length]!, cap)
}

/**
 * The ONE near-miss rule every "did you mean" hint applies: the closest
 * candidate within two edits of `name` (for a name of four letters or
 * fewer, one or a swap of two), or undefined — an exact match is
 * not a hint, and anything further would guess rather than help. Task
 * names, `pkg#task` halves, project names, flags and verbs all go through
 * here so a typo is hinted the same way wherever it is typed.
 */
export function nearest(
  name: string,
  candidates: Iterable<string>,
  maxEdits = 2,
): string | undefined {
  // Two edits rewrite half of a word of four letters or fewer (`--poll`
  // read as `--all`, `vx test` as `last`), unless they swap two letters.
  const short = maxEdits === 2 && name.replace(/^-+/, '').length <= 4
  let best: string | undefined
  let bestD = maxEdits + 1
  for (const c of candidates) {
    // Capped one past the budget, so "past it" never reads as within it:
    // `--continue-on-error` was nine edits from `--concurrency`, capped to
    // the three `vx run`'s same-prefix hint allows, and offered.
    const d = editDistance(name, c, maxEdits + 1)
    // Edits that rewrite the whole of both leave nothing in common:
    // `--filter=x9` offered the root, `//`.
    if (d >= Math.max(name.length, c.length)) continue
    if (short && d === 2 && !sameLetters(name, c)) continue
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best === name ? undefined : best
}

function sameLetters(a: string, b: string): boolean {
  return a.length === b.length && a.split('').sort().join('') === b.split('').sort().join('')
}

/**
 * Up to `limit` candidates worth offering for `name`: the nearest by edit
 * distance first, then any that contain it (or that it contains), case-
 * insensitively — the inspection verbs (`why`, `prune`) list a few rather
 * than pick one, since a partial name is as common a query there as a
 * typo. Never includes `name` itself.
 */
export function nearMatches(name: string, candidates: Iterable<string>, limit = 3): string[] {
  const all = [...new Set(candidates)].filter((c) => c !== name)
  const q = name.toLowerCase()
  const byDistance = all
    .map((c) => [c, editDistance(name, c)] as const)
    .filter(([, d]) => d < 3)
    .sort((a, b) => a[1] - b[1])
    .map(([c]) => c)
  const out = [...byDistance]
  for (const c of all) {
    if (out.length >= limit) break
    if (out.includes(c)) continue
    const n = c.toLowerCase()
    if (n.includes(q) || q.includes(n)) out.push(c)
  }
  return out.slice(0, limit)
}

/**
 * The names to offer when no one name is near: sorted, the first `limit`,
 * then a count. A typo past two edits named nothing to pick from (M-56).
 */
export function listed(names: Iterable<string>, limit = 8): string {
  const all = [...new Set(names)].sort()
  const more = all.length - limit
  return all.slice(0, limit).join(', ') + (more > 0 ? `, and ${more} more` : '')
}
