// What the Guide's chapter rows (guide-<slug>.test.ts) share: reading a
// built chapter, taking its prose apart from its widgets and pictures, and
// the rows every chapter owes (`chapterShape`). A chapter's evidence sits in
// one collapsed list at the end of "In vx": each link names a site page
// (which must exist, at an anchor it has) or a vx test file on GitHub, which
// must exist here and hold the row the chapter leans on.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { Picture } from '../src/components/guide/sketch.js'

export const SITE = path.resolve(import.meta.dir, '..')
export const DIST = path.join(SITE, 'dist')
const REPO = path.resolve(SITE, '../..')
const OXLINT = path.join(REPO, 'node_modules/.bin/oxlint')
// astro.config.mjs reads the same variable with the same default.
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const GH = 'https://github.com/vznjs/vx/blob/main/'

/** The running example's packages, the only ones a chapter's prose names. */
export const TOY = ['utils', 'ui', 'api', 'app']

/** The tools the Guide does not compare itself with inside a chapter. */
const COMPETITORS = /\b(?:Turborepo|Turbo|Nx|Bazel)\b/g

export function page(rel: string): string {
  const file = path.join(DIST, rel, 'index.html')
  if (!existsSync(file)) throw new Error(`${file} is missing: run the site's build task first`)
  return readFileSync(file, 'utf8')
}

export function only(html: string, re: RegExp): string {
  const found = [...html.matchAll(re)]
  expect(found).toHaveLength(1)
  return found[0]![1]!
}

export function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

export function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** The chapter itself: Starlight's content column, up to its footer. */
export function content(html: string): string {
  const start = html.indexOf('<div class="sl-markdown-content">')
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('<footer', start)
  return html.slice(start, end === -1 ? undefined : end)
}

/** The chapter's `##` sections in order, each with its id and markup. */
export function sections(chapter: string): { id: string; html: string }[] {
  // Starlight wraps each `##` in a heading div; a section ends where the
  // next one's wrapper starts.
  return [
    ...chapter.matchAll(/<h2 id="([^"]+)">[\s\S]*?(?=<div class="sl-heading-wrapper|<h2 id="|$)/g),
  ].map((m) => ({
    id: m[1]!,
    html: m[0],
  }))
}

/** The chapter without its widgets: every `<vx-…>` element is cut out, so
 *  what is left is what the author wrote. */
export function prose(chapter: string): string {
  return chapter.replace(/<(vx-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g, '')
}

/** Every package a text names: in a task id (`ui#build`) or a path
 *  (`packages/ui/src/button.tsx`). */
function packagesNamed(s: string): string[] {
  const named = [
    ...[...s.matchAll(/(?<![\w@/.-])([\w@][\w@./-]*)#[a-z][\w.-]*/g)].map((m) => m[1]!),
    ...[...s.matchAll(/\bpackages\/([\w.-]+)\//g)].map((m) => m[1]!),
  ]
  return [...new Set(named)].sort()
}

/** Each code block in `html` in the given language, as its text. Expressive
 *  Code puts one `ec-line` per source line. */
export function codeBlocks(html: string, lang: string): string[] {
  return [
    ...html.matchAll(
      new RegExp(`<pre data-language="${lang}"><code>([\\s\\S]*?)</code></pre>`, 'g'),
    ),
  ].map((m) =>
    m[1]!
      .split(/<div class="ec-line[^"]*">/)
      .slice(1)
      .map((line) => decode(line.replace(/<[^>]+>/g, '')).replace(/\n$/, ''))
      .join('\n'),
  )
}

/** The rows of a table's body: each row's cells as text, header cell first. */
export function tableRows(table: string): string[][] {
  const body = only(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1]!)),
  )
}

/** Every `_astro/*.js` reachable from `names` through the chunks' imports. */
export function closure(names: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...names]
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    for (const m of readFileSync(file, 'utf8').matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) {
      queue.push(m[1]!)
    }
  }
  return seen
}

/** The chunks reachable from the page's own scripts that define `<tag>`. */
export function defining(html: string, tag: string): string[] {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const entry = scripts.flatMap((s) =>
    [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
  )
  const define = new RegExp(`customElements\\.define\\(\\s*["'\`]${tag}["'\`]`)
  return [...closure(entry)].filter((name) =>
    define.test(readFileSync(path.join(DIST, '_astro', name), 'utf8')),
  )
}

/**
 * Why a link in chapter `slug` does not land, or undefined when it does. A
 * vx test file must exist and hold every row `rows` lists for it (a title
 * in quotes, as `it(` takes it); a site link must name a built page, and a
 * fragment an id on it.
 */
function miss(slug: string, href: string, rows: Record<string, string[]>): string | undefined {
  if (href.startsWith(GH)) {
    const rel = href.slice(GH.length)
    const file = path.join(REPO, rel)
    if (!existsSync(file)) return `${rel} does not exist`
    const wanted = rows[rel]
    if (wanted === undefined) return `${rel} is linked, but no row is written out for it`
    const body = readFileSync(file, 'utf8')
    const missing = wanted.filter((r) => !body.includes(`'${r}'`))
    return missing.length === 0 ? undefined : `${rel} has no row ${missing.join(' / ')}`
  }
  if (/^[a-z]+:/.test(href)) return undefined
  const url = new URL(decode(href), `https://site${BASE}guide/${slug}/`)
  const rel = decodeURIComponent(url.pathname.slice(BASE.length))
  const file = path.join(DIST, rel, 'index.html')
  if (!existsSync(file)) return `${href}: no page ${rel}`
  const anchor = url.hash.slice(1)
  if (anchor !== '' && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
    return `${href}: no id ${anchor} on ${rel}`
  }
  return undefined
}

/** Every `href` in `html`. */
export function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => decode(m[1]!))
}

/**
 * Type-check `files` (path under a scratch root → contents, or a file of
 * this repo to copy) against the workspace's own packages, the way
 * config-snippets.test.ts does: outside the repo, so the test never writes
 * into a tree the cache hashes, and each file named, since oxlint pointed
 * at a directory walks the symlinked node_modules.
 */
export async function typeCheck(files: Record<string, string | { copy: string }>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-guide-'))
  try {
    await symlink(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'esnext',
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ['bun'],
          // Through the site's own link, which the sandbox grants; the
          // root's node_modules has no @vzn/vx-migrate.
          paths: {
            '@vzn/vx-migrate': [path.join(SITE, 'node_modules/@vzn/vx-migrate/src/index.ts')],
          },
        },
        include: ['**/*.ts'],
      }),
    )
    const checked: string[] = []
    for (const [rel, body] of Object.entries(files)) {
      const to = path.join(dir, rel)
      await mkdir(path.dirname(to), { recursive: true })
      if (typeof body === 'string') await writeFile(to, body)
      else await copyFile(body.copy, to)
      checked.push(to)
    }
    const p = Bun.spawnSync({
      cmd: [OXLINT, '--type-aware', '--type-check', ...checked],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
    const errors = out.split('\n').filter((l) => /^\s*x |: error /.test(l))
    const tail = p.exitCode === 0 ? [] : out.trim().split('\n').slice(-20)
    expect({ exitCode: p.exitCode, errors, tail }).toEqual({ exitCode: 0, errors: [], tail: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The `vx run` flags `docs/cli.md` documents, from its flag table (the
 *  site's imported copy), each with whether it takes a value. */
export function runFlags(): Map<string, boolean> {
  const cli = readFileSync(path.join(SITE, 'src/content/docs/cli.md'), 'utf8')
  const flags = new Map<string, boolean>()
  for (const m of cli.matchAll(
    /^\| `(--[\w-]+)([^`]*)`\s*\|\s*(boolean|value|optional value)\s*\|/gm,
  )) {
    flags.set(m[1]!, m[3] !== 'boolean')
  }
  return flags
}

/** The text of a chapter's `##` titles, in order. */
function titles(chapter: string): string[] {
  return [...chapter.matchAll(/<h2 id="[^"]+">([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]!))
}

/** Words of prose a reader has to read: the `<p>`s outside figures, answers
 *  and code (the simple brief's budget, 2026-09-24). */
function proseWords(chapter: string): number {
  const bare = prose(chapter)
    .replace(/<details\b[\s\S]*?<\/details>/g, '')
    .replace(/<pre\b[\s\S]*?<\/pre>/g, '')
    .replace(/<figure\b[\s\S]*?<\/figure>/g, '')
  return [...bare.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
    .map(
      (m) =>
        text(m[1]!)
          .split(/\s+/)
          .filter((w) => w !== '').length,
    )
    .reduce((a, b) => a + b, 0)
}

/** A Guide picture as the page shipped it (Sketch.astro), each part as a
 *  line so a mismatch reads as a diff. */
interface Rendered {
  name: string
  label: string
  caption: string
  boxes: string[]
  arrows: string[]
  notes: string[]
}

function pictures(chapter: string): Rendered[] {
  return [
    ...chapter.matchAll(
      /<figure class="vx-diagram\b[^"]*" data-picture="([^"]+)"[^>]*>([\s\S]*?)<\/figure>/g,
    ),
  ].map((m) => {
    // Astro scopes the component's style with a class on each element.
    const body = m[2]!.replace(/ astro-[a-z0-9]+(?=")/g, '')
    const svg = only(body, /(<svg\b[\s\S]*<\/svg>)/g)
    expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
    return {
      name: m[1]!,
      label: decode(only(svg, /^<svg\b[^>]*aria-label="([^"]*)"/g)),
      caption: text(only(body, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g)),
      boxes: [
        ...svg.matchAll(
          /<g class="box (\w+)" data-box="([^"]+)">[\s\S]*?<text class="label"[^>]*>([^<]*)<\/text>(?:\s*<text class="sub"[^>]*>([^<]*)<\/text>)?/g,
        ),
      ].map(
        (b) =>
          `${b[2]} ${b[1]}: ${decode(b[3]!).trim()}${b[4] === undefined ? '' : ` / ${decode(b[4]).trim()}`}`,
      ),
      arrows: [
        ...svg.matchAll(
          /<g class="arrow (\w+)" data-from="([^"]+)" data-to="([^"]+)">\s*<path\b[^>]*>(?:<\/path>)?\s*(?:<text\b[^>]*>([^<]*)<\/text>)?/g,
        ),
      ].map(
        (a) => `${a[2]} → ${a[3]} ${a[1]}${a[4] === undefined ? '' : `: ${decode(a[4]).trim()}`}`,
      ),
      notes: [...svg.matchAll(/<text class="note\b[^"]*"[^>]*>([^<]*)<\/text>/g)].map((n) =>
        decode(n[1]!).trim(),
      ),
    }
  })
}

/** What `pictures()` should read back for a picture's data. */
function expected(p: Picture): Rendered {
  return {
    name: p.name,
    label: p.label,
    caption: p.caption,
    boxes: p.boxes.map(
      (b) =>
        `${b.id} ${b.tone ?? 'default'}: ${b.label}${b.sub === undefined ? '' : ` / ${b.sub}`}`,
    ),
    arrows: (p.arrows ?? []).map(
      (a) =>
        `${a.from} → ${a.to} ${a.tone ?? 'default'}${a.label === undefined ? '' : `: ${a.label}`}`,
    ),
    notes: (p.notes ?? []).map((n) => n.text),
  }
}

/** The one collapsed list of test links at the end of "In vx". */
const PROOFS = /<details>\s*<summary>How we know this is true<\/summary>([\s\S]*?)<\/details>/g

export interface Chapter {
  slug: string
  /** The `##` titles before "In vx", in order; each is the section's point. */
  titles: string[]
  /** The chapter's pictures, in page order. */
  pictures: Picture[]
  /** Each vx test file the proof list links, and the rows it leans on. */
  rows: Record<string, string[]>
  /** The competitor names "In vx" holds, in order; none may appear elsewhere. */
  inVxNames?: string[]
}

/** The rows every Guide chapter shares under the simple brief (2026-09-24):
 *  its titles, its pictures, its word budget, "In vx" as one sentence, one
 *  block and the proof list, one question, and the four-package and
 *  no-competitor laws. */
export function chapterShape(c: Chapter): void {
  describe(`guide/${c.slug}, the chapter`, () => {
    const chapter = content(page(`guide/${c.slug}`))
    const parts = sections(chapter)
    const inVx = parts.find((s) => s.id === 'in-vx')!.html
    const check = parts.find((s) => s.id === 'check-yourself')!.html

    it('titles its sections with their point, then "In vx" and "Check yourself"', () => {
      expect(titles(chapter)).toEqual([...c.titles, 'In vx', 'Check yourself'])
    })

    it('draws its pictures, each named, captioned and as its data says', () => {
      expect(c.pictures.length).toBeGreaterThanOrEqual(3)
      expect(pictures(chapter)).toEqual(c.pictures.map(expected))
    })

    it('keeps its prose within the budget', () => {
      const words = proseWords(chapter)
      expect(words).toBeGreaterThan(20)
      expect(words).toBeLessThanOrEqual(350)
    })

    it('says "In vx" in one sentence and one code block, then the proof list', () => {
      const bare = inVx.replace(PROOFS, '')
      expect(bare.match(/<p\b/g)).toHaveLength(1)
      expect(bare.match(/<pre\b/g)).toHaveLength(1)
      expect(inVx.match(PROOFS)).toHaveLength(1)
      expect(inVx.trimEnd()).toMatch(/<\/details>$/)
    })

    it('links tests only from the proof list, and every link lands', () => {
      const proofs = hrefs(only(inVx, PROOFS))
      const outside = hrefs(prose(chapter).replace(PROOFS, '')).filter((h) => !h.startsWith('#'))
      expect(outside.filter((h) => h.startsWith('https://github.com/'))).toEqual([])
      const files = proofs.filter((h) => h.startsWith(GH)).map((h) => h.slice(GH.length))
      expect([...new Set(files)].sort()).toEqual(Object.keys(c.rows).sort())
      const all = [...proofs, ...outside]
      expect(all.map((h) => miss(c.slug, h, c.rows)).filter((m) => m !== undefined)).toEqual([])
    })

    it('asks one question', () => {
      const asked =
        (check.match(/<details>/g) ?? []).length + (check.match(/<vx-checkpoint\b/g) ?? []).length
      expect(asked).toBe(1)
    })

    it('names only the four toy packages', () => {
      // Tags become spaces: an SVG's texts sit side by side with none.
      const named = packagesNamed(decode(prose(chapter).replace(/<[^>]+>/g, ' ')))
      expect(named.length).toBeGreaterThan(0)
      expect(named.filter((p) => !TOY.includes(p))).toEqual([])
    })

    it('names no other tool outside "In vx"', () => {
      const spaced = decode(chapter.replace(inVx, '').replace(/<[^>]+>/g, ' '))
      expect(spaced.match(COMPETITORS) ?? []).toEqual([])
      expect([...(text(inVx).match(COMPETITORS) ?? [])]).toEqual(c.inVxNames ?? [])
    })
  })
}
