// The heading ids a Markdown page renders with, as github-slugger derives
// them (Astro's heading ids, so the site's `#anchor` links land or miss by
// this rule): lowercase, every character that is not a letter, a digit, a
// space, `-` or `_` dropped, spaces to `-`, a repeated slug suffixed `-1`,
// `-2`, … Fenced code is skipped — a `# comment` inside a shell block is
// not a heading.

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

export function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const out = new Set<string>()
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (m === null) continue
    const base = slugify(m[1]!)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

export interface AnchoredLink {
  target: string
  anchor: string
}

/** Every `](target#anchor)` link in the prose, code fences skipped. */
export function anchoredLinks(markdown: string): AnchoredLink[] {
  const out: AnchoredLink[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const m of line.matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
      out.push({ target: m[1]!, anchor: m[2]! })
    }
  }
  return out
}
