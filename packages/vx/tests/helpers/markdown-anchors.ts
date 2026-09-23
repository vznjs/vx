// The heading ids a Markdown page renders with, as github-slugger derives
// them (Astro's heading ids, so the site's `#anchor` links land or miss by
// this rule): lowercase, every character that is not a letter, a digit, a
// space, `-` or `_` dropped, spaces to `-`, a repeated slug suffixed `-1`,
// `-2`, … Fenced code is skipped — a `# comment` inside a shell block is
// not a heading, and a `](x.md#anchor)` quoted in one is not a link.

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

function proseLines(markdown: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced) out.push(line)
  }
  return out
}

export function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const out = new Set<string>()
  for (const line of proseLines(markdown)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (m === null) continue
    const base = slugify(m[1]!)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

export interface ProseLink {
  /** The path before any `#`; `''` for a same-page anchor. */
  target: string
  anchor: string | undefined
}

/** Every relative `](target)` / `](target#anchor)` link in the prose; absolute URLs are not the docs' to keep. */
export function proseLinks(markdown: string): ProseLink[] {
  const out: ProseLink[] = []
  for (const line of proseLines(markdown)) {
    for (const m of line.matchAll(/\]\(([^)\s#]*)(?:#([^)\s]+))?\)/g)) {
      const target = m[1]!
      if (/^[a-z]+:/.test(target)) continue
      out.push({ target, anchor: m[2] })
    }
  }
  return out
}
