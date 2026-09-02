#!/usr/bin/env bun
/**
 * Import the canonical Markdown in `docs/` into the Starlight content
 * collection. The repo's `docs/` tree stays the single source of truth;
 * this script adds frontmatter and rewrites internal `.md` links to
 * Starlight clean URLs. It is idempotent and runs before every dev/build.
 *
 * Hand-authored pages (index.mdx, getting-started.md) are never touched —
 * this script only writes the generated set listed in GENERATED below.
 */
import { Glob } from 'bun'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const HERE = import.meta.dir
const DOCS_DIR = path.resolve(HERE, '../../../docs')
const OUT_DIR = path.resolve(HERE, '../src/content/docs')

// ---- path helpers (POSIX, within the docs tree) ----

function normalize(p: string): string {
  const parts = p.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** docs-relative source path (e.g. "modules/cache.md") -> clean URL ("modules/cache/"). */
function cleanUrlFor(srcRel: string): string {
  if (srcRel === 'README.md') return 'overview/'
  if (srcRel === 'modules/README.md') return 'modules/'
  const noExt = srcRel.replace(/\.md$/i, '')
  return `${noExt}/`
}

/** docs-relative source path -> output file path within the content collection. */
function outRelFor(srcRel: string): string {
  if (srcRel === 'README.md') return 'overview.md'
  if (srcRel === 'modules/README.md') return 'modules/index.md'
  return srcRel
}

// ---- collect sources & build the link map ----

const sources: string[] = []
for (const pattern of ['*.md', 'modules/*.md', 'design/*.md']) {
  for (const f of new Glob(pattern).scanSync({ cwd: DOCS_DIR })) {
    // STATUS.md is the maintainers' handoff, not user documentation.
    if (f === 'STATUS.md') continue
    sources.push(f.split(path.sep).join('/'))
  }
}

// key (no extension, no trailing slash) -> clean URL
const linkMap = new Map<string, string>()
for (const srcRel of sources) {
  const key = srcRel.replace(/\.md$/i, '')
  linkMap.set(key, cleanUrlFor(srcRel))
}
// directory links: ./modules/ and ./design/ resolve to their index pages.
linkMap.set('modules', 'modules/')
linkMap.set('design', 'design/')

// ---- link rewriting ----

function resolveInternal(url: string, sourceDir: string, prefix: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) {
    return null
  }
  const hash = url.indexOf('#')
  const pathPart = hash === -1 ? url : url.slice(0, hash)
  const anchor = hash === -1 ? '' : url.slice(hash)
  if (pathPart === '') return null

  const resolved = normalize(sourceDir ? `${sourceDir}/${pathPart}` : pathPart)
  const key = resolved.replace(/\/$/, '').replace(/\.md$/i, '')
  const target = linkMap.get(key)
  if (!target) return null
  return `${prefix}${target}${anchor}`
}

const LINK_RE = /\]\(([^)\s]+)(\s+"[^"]*")?\)/g
// vx placeholder convention in prose: <hash>, <cacheDir>, <rel>, … — escape
// so Markdown doesn't treat them as raw HTML tags. Conservative: letters then
// only word / . / / * / - chars (no ':' so autolinks like <https://…> survive).
const PLACEHOLDER_RE = /<([A-Za-z][\w./*-]*)>/g

function transformText(text: string, sourceDir: string, prefix: string): string {
  const linked = text.replace(LINK_RE, (whole, url: string, title = '') => {
    const rewritten = resolveInternal(url, sourceDir, prefix)
    return rewritten ? `](${rewritten}${title})` : whole
  })
  return linked.replace(PLACEHOLDER_RE, '&lt;$1&gt;')
}

/** Transform a prose line, leaving inline `code spans` untouched. */
function transformProse(line: string, sourceDir: string, prefix: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 0
      while (line[i + n] === '`') n++
      const fence = '`'.repeat(n)
      const close = line.indexOf(fence, i + n)
      if (close === -1) {
        // Unterminated code span — treat the remainder as prose.
        out += transformText(line.slice(i), sourceDir, prefix)
        break
      }
      out += line.slice(i, close + n) // code span verbatim
      i = close + n
    } else {
      let j = i
      while (j < line.length && line[j] !== '`') j++
      out += transformText(line.slice(i, j), sourceDir, prefix)
      i = j
    }
  }
  return out
}

// ---- per-file transform ----

const yaml = (s: string) => JSON.stringify(s)

function deriveDescription(lines: string[]): string {
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (/^[#>|`-]|^\*|^\d+\.|^<|^!\[|^:::/.test(line)) continue
    const plain = line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
      .replace(/<([A-Za-z][\w./*-]*)>/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (plain.length < 24) continue
    return plain.length > 158 ? `${plain.slice(0, 157).replace(/\s+\S*$/, '')}…` : plain
  }
  return ''
}

function transformFile(srcRel: string, content: string): string {
  const cleanUrl = cleanUrlFor(srcRel)
  const depth = cleanUrl.replace(/\/$/, '').split('/').length
  const prefix = '../'.repeat(depth)
  const sourceDir = srcRel.includes('/') ? srcRel.slice(0, srcRel.lastIndexOf('/')) : ''

  const lines = content.replace(/\r\n/g, '\n').split('\n')

  // Pull the first H1 as the page title and drop it (Starlight renders the
  // frontmatter title as the page heading).
  let title = ''
  let titleIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]!)
    if (m) {
      title = m[1]!.replace(/`/g, '').trim()
      titleIdx = i
      break
    }
  }
  if (titleIdx !== -1) lines.splice(titleIdx, 1)
  if (!title) {
    const base = path.basename(srcRel, '.md')
    title = base === 'README' ? 'Overview' : base
  }

  const description = deriveDescription(lines)

  // Transform body line-by-line, skipping fenced code blocks.
  let inFence = false
  let fenceMarker = ''
  const body = lines.map((line) => {
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]![0]!
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false
      }
      return line
    }
    return inFence ? line : transformProse(line, sourceDir, prefix)
  })

  const fm = ['---', `title: ${yaml(title)}`]
  if (description) fm.push(`description: ${yaml(description)}`)
  fm.push('---', '')
  return `${fm.join('\n')}${body.join('\n').replace(/^\n+/, '')}`
}

// ---- design index (so /design/ and ./design/ links resolve) ----

function designIndex(designFiles: { url: string; title: string }[]): string {
  const items = designFiles
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((d) => `- [${d.title}](../${d.url})`)
    .join('\n')
  return `---
title: Design notes
description: Forward-looking proposals and historical design notes for vx — the record of what was explored and why.
---

These are forward-looking proposals and historical design notes — the
record of what was explored, what shipped, and why. They are not part of
the stable contract.

${items}
`
}

// ---- run ----

const GENERATED = ['overview.md', 'modules', 'design']

for (const entry of GENERATED) {
  await rm(path.join(OUT_DIR, entry), { recursive: true, force: true })
}

const designFiles: { url: string; title: string }[] = []

for (const srcRel of sources) {
  const content = await Bun.file(path.join(DOCS_DIR, srcRel)).text()
  const transformed = transformFile(srcRel, content)
  const outRel = outRelFor(srcRel)
  const outPath = path.join(OUT_DIR, outRel)
  await mkdir(path.dirname(outPath), { recursive: true })
  await Bun.write(outPath, transformed)

  if (srcRel.startsWith('design/')) {
    const m = /^title:\s*(.+)$/m.exec(transformed)
    const title = m ? JSON.parse(m[1]!) : srcRel
    designFiles.push({ url: cleanUrlFor(srcRel), title })
  }
}

await Bun.write(path.join(OUT_DIR, 'design/index.md'), designIndex(designFiles))

console.log(`imported ${sources.length} docs → ${path.relative(process.cwd(), OUT_DIR)}`)
