// The docs guide's checkable rules (org/docs-site/docs-research.md, owner
// 2026-10-26): no prose paragraph longer than five lines on a phone (200
// characters, as it renders), no plain white output block ("I don't wanna
// see ever a plain white output"), and none of the internal words. Read from
// the sources, where the author writes them.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const CONTENT = path.resolve(import.meta.dir, '../src/content/docs')
const MAX_PARAGRAPH = 200
// Wrong even in code font.
const BANNED =
  /not on npm|coming soon|bun link|from a checkout|\bcurrently\b|\bnot yet\b|\bat present\b|\beventually\b|distributed runs?\b|\bsimply\b|\bjust\b|\beasily\b|\bpowerful\b|\bseamless\b|\bnpx\b|npm run|pnpm run|\blet's\b/i
// Code internals (the guide's section 3), in prose: a name in code font or a
// quoted message passes.
const INTERNAL =
  /\bseams?\b|\bfloor\b|\bchain(s|ed)?\b|\bclaim(s|ed|ing)?\b|\badmits|\badmitt(ed|ing)\b|\badmission\b|\btaint(s|ed)?\b|\bplacement\b|\bfold(s|ed|ing)?\b|\bstaged\b|\bmemo(s|ized)?\b|\blayered cache\b|\bremote layer\b/i
// Stage names belong on the plugin reference only.
const STAGE = /\bfingerprints?\b|\badmit\b/i
const PLUGIN_REFERENCE = 'docs/writing-plugins.mdx'
// A shell sample installs and runs with bun (the guide's M5).
const SHELL = /^(sh|bash|shell|zsh|console)$/
const SHELL_BANNED =
  /\bnpx\b|\bnpm (run|install|i|exec)\b|\bpnpm (run|add|install|exec|dlx)\b|\byarn (add|run|dlx)\b|\bbun link\b/
const ESC = String.fromCharCode(27)

// Pages these rules reach.
const ROOTS = ['docs', 'guides', 'quickstart.mdx', 'glossary.md']
// The generated upgrading guide quotes commit footers, which git keeps as written.
const LATER = new Set(['guides/upgrading.md'])

const pages = (rel: string): string[] => {
  const abs = path.join(CONTENT, rel)
  if (!statSync(abs).isDirectory()) return /\.mdx?$/.test(rel) ? [rel] : []
  return readdirSync(abs).flatMap((f) => pages(path.join(rel, f)))
}

const prose = (line: string): string =>
  line.replace(/``.*?``|`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']')

function problems(rel: string): string[] {
  const out: string[] = []
  const lines = readFileSync(path.join(CONTENT, rel), 'utf8').split('\n')
  let front = lines[0] === '---'
  let fence: { marker: string; lang: string; start: number; esc: boolean } | undefined
  let para: string[] = []
  let start = 0
  const flush = () => {
    const text = para
      .join(' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*|`/g, '')
      .trim()
    if (text.length > MAX_PARAGRAPH) out.push(`${rel}:${start} paragraph of ${text.length}`)
    para = []
  }
  const words = (line: string, i: number) => {
    const banned = BANNED.exec(line)
    if (banned) out.push(`${rel}:${i + 1} "${banned[0]}"`)
    const p = prose(line)
    const internal = INTERNAL.exec(p) ?? (rel === PLUGIN_REFERENCE ? null : STAGE.exec(p))
    if (internal) out.push(`${rel}:${i + 1} internal "${internal[0]}"`)
  }
  lines.forEach((line, i) => {
    if (front) {
      if (i > 0 && line === '---') front = false
      else if (/^(title|description):/.test(line)) words(line, i)
      return
    }
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line)
    if (fence) {
      if (open && open[1] === fence.marker && !open[2]) {
        if (fence.lang === 'ansi' && !fence.esc)
          out.push(`${rel}:${fence.start} ansi with no colour`)
        fence = undefined
        return
      }
      if (line.includes(ESC)) fence.esc = true
      const shell = SHELL.test(fence.lang) ? SHELL_BANNED.exec(line) : null
      if (shell) out.push(`${rel}:${i + 1} "${shell[0]}" in a shell sample`)
      return
    }
    if (open) {
      const lang = open[2]!.toLowerCase()
      if (!lang || /^(text|txt|plain|plaintext)$/.test(lang))
        out.push(`${rel}:${i + 1} plain fence`)
      fence = { marker: open[1]!, lang, start: i + 1, esc: false }
      flush()
      return
    }
    words(line, i)
    const isProse = line.trim() && !/^\s*([#|<>\-*+:]|\d+\.|import |export |\{)/.test(line)
    if (!isProse) return flush()
    if (!para.length) start = i + 1
    para.push(line.trim())
  })
  flush()
  return out
}

describe('every page reads on a phone', () => {
  const all = ROOTS.flatMap(pages)

  it('walks the pages', () => {
    expect(all.length).toBeGreaterThan(20)
    for (const rel of LATER) expect(all).toContain(rel)
  })

  it('keeps paragraphs short, output coloured, and internal words out', () => {
    expect(all.filter((rel) => !LATER.has(rel)).flatMap(problems)).toEqual([])
  })

  // CONTROL: the check sees a long paragraph and an internal word.
  it('catches what it is for', () => {
    const found = problems('guides/upgrading.md')
    expect(found.some((p) => p.includes('paragraph of'))).toBe(true)
    expect(found.some((p) => p.includes('internal'))).toBe(true)
  })
})
