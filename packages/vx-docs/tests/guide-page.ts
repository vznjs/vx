// What the Guide's chapter rows (guide-<slug>.test.ts) share: reading a
// built chapter, taking its prose apart from its widgets and pictures, the
// rows every chapter owes (`chapterShape`), and a real toy workspace vx
// plans, so a chapter's "In vx" config is held to what vx does with it
// rather than to what the page says it does.
//
// A chapter's evidence sits in one collapsed list at the end of "In vx":
// each link names a site page (which must exist, at an anchor it has) or a
// vx test file on GitHub, which must exist here and hold the rows the
// chapter leans on; a link's title, when it has one, is one of those rows.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun, type Logger, type RunPlan } from '@vzn/vx'
import type { Picture } from '../src/components/guide/diagram/diagram.js'

export const SITE = path.resolve(import.meta.dir, '..')
export const DIST = path.join(SITE, 'dist')
const REPO = path.resolve(SITE, '../..')
const OXLINT = path.join(REPO, 'node_modules/.bin/oxlint')
// astro.config.mjs reads the same variable with the same default.
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const GH = 'https://github.com/vznjs/vx/blob/main/'

/** The running example's packages, the only ones a chapter names. */
export const TOY = ['utils', 'ui', 'api', 'app']

/** The running example, written out by hand: package → the packages it uses. */
export const TOY_USES: Record<string, string[]> = {
  utils: [],
  ui: ['utils'],
  api: ['utils'],
  app: ['ui', 'api'],
}

/** The tools the Guide does not compare itself with inside a chapter. */
const COMPETITORS = /\b(?:Turborepo|Turbo|turbo|Nx|nx|Bazel|bazel)\b/g

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

/** Markup as the text a reader gets, whitespace collapsed. */
export function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Markup as separate words: each tag is a break, so the cells of a table
 *  or the labels of a chart never run together. */
export function words(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** A `<pre>`'s text, whitespace kept. */
export function pre(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ''))
}

/** The chapter itself: Starlight's content column, up to the footer. The
 *  chapter's header and its Next card are the layout's (the PageTitle and
 *  Footer overrides), and name other chapters, so they stay outside. */
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
  ].map((m) => ({ id: m[1]!, html: m[0] }))
}

export function section(chapter: string, id: string): string {
  const found = sections(chapter).filter((s) => s.id === id)
  expect(found).toHaveLength(1)
  return found[0]!.html
}

/** The chapter without its widgets: every `<vx-…>` element is cut out, so
 *  what is left is what the author wrote. */
export function prose(chapter: string): string {
  return chapter.replace(/<(vx-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g, '')
}

/** Every package a text names: in a task id (`ui#build`) or a path
 *  (`packages/ui/src/button.tsx`, `ui/src/…`). */
function packagesNamed(s: string): string[] {
  const named = [
    ...[...s.matchAll(/(?<![\w@/.-])([\w@][\w@./-]*)#[a-z][\w.-]*/g)].map((m) => m[1]!),
    ...[...s.matchAll(/\bpackages\/([\w.-]+)\//g)].map((m) => m[1]!),
    ...[...s.matchAll(/(?<![\w/.-])([a-z][\w-]*)\/(?:src|dist)\//g)].map((m) => m[1]!),
  ]
  // The notation's own name for a task.
  return [...new Set(named)].filter((n) => n !== 'package').sort()
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

/** The chapter's fenced code blocks as written in its source, in order;
 *  only one language's when `lang` is given (`''` for a bare fence). */
export function sourceBlocks(slug: string, lang?: string): string[] {
  const source = readFileSync(path.join(SITE, `src/content/docs/guide/${slug}.mdx`), 'utf8')
  return [...source.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)]
    .filter((m) => lang === undefined || m[1] === lang)
    .map((m) => m[2]!)
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
    // mermaid's chunks name files it never emits (`./elk-worker.min.js`).
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    for (const m of readFileSync(file, 'utf8').matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) {
      queue.push(m[1]!)
    }
  }
  return seen
}

/** Every `_astro/*.js` the page loads, followed through the chunks' imports. */
export function reachableScripts(html: string): Set<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  return closure(
    scripts.flatMap((s) => [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!)),
  )
}

/** The chunks reachable from the page's own scripts that define `<tag>`. */
export function defining(html: string, tag: string): string[] {
  const define = new RegExp(`customElements\\.define\\(\\s*["'\`]${tag}["'\`]`)
  return [...reachableScripts(html)].filter((name) =>
    define.test(readFileSync(path.join(DIST, '_astro', name), 'utf8')),
  )
}

interface Link {
  href: string
  /** The link's title: the test row it stands for, when it names one. */
  title: string | undefined
}

/** Every link in `html`, with its title. */
function links(html: string): Link[] {
  return [...html.matchAll(/<a\b([^>]*)>/g)]
    .filter((m) => !/\bclass="sl-anchor-link"/.test(m[1]!))
    .flatMap((m) => {
      const href = /\shref="([^"]+)"/.exec(m[1]!)
      if (href === null) return []
      const title = /\stitle="([^"]*)"/.exec(m[1]!)
      return [{ href: decode(href[1]!), title: title === null ? undefined : decode(title[1]!) }]
    })
}

/** Every `href` in `html`. */
export function hrefs(html: string): string[] {
  return links(html).map((l) => l.href)
}

/**
 * Why a link in chapter `slug` does not land, or undefined when it does. A
 * vx test file must exist and hold every row `rows` lists for it (a title
 * in quotes, as `it(` takes it), and a link's title must be one of those; a
 * site link must name a built page, and a fragment an id on it.
 */
function miss(slug: string, link: Link, rows: Record<string, string[]>): string | undefined {
  const { href } = link
  if (href.startsWith(GH)) {
    const rel = href.slice(GH.length)
    const file = path.join(REPO, rel)
    if (!existsSync(file)) return `${rel} does not exist`
    const wanted = rows[rel]
    if (wanted === undefined) return `${rel} is linked, but no row is written out for it`
    if (link.title !== undefined && !wanted.includes(link.title)) {
      return `${rel} is linked for the row "${link.title}", which the chapter's rows do not list`
    }
    const body = readFileSync(file, 'utf8')
    const missing = wanted.filter(
      (r) => ![`'${r}'`, `"${r}"`, `\`${r}\``].some((q) => body.includes(q)),
    )
    return missing.length === 0 ? undefined : `${rel} has no row ${missing.join(' / ')}`
  }
  if (/^[a-z]+:/.test(href) || href.startsWith('#')) return undefined
  const url = new URL(href, `https://site${BASE}guide/${slug}/`)
  const rel = decodeURIComponent(url.pathname.slice(BASE.length))
  const file = path.join(DIST, rel, 'index.html')
  if (!existsSync(file)) return `${href}: no page ${rel}`
  const anchor = decodeURIComponent(url.hash.slice(1))
  if (anchor !== '' && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
    return `${href}: no id ${anchor} on ${rel}`
  }
  return undefined
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

/** Words of prose a reader has to read: the `<p>`s outside figures, answers,
 *  code and widgets (the simple brief's budget, 2026-09-24). */
export function proseWords(chapter: string): number {
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

/** One picture's markup, from its `<figure>` to its `</figure>`, by name. */
export function figure(chapter: string, name: string): string {
  return only(
    chapter,
    new RegExp(
      `(<figure class="vx-diagram\\b[^"]*" data-picture="${name}"[\\s\\S]*?</figure>)`,
      'g',
    ),
  )
}

/** A Guide picture as the page shipped it (Diagram.astro), each part as a
 *  line so a mismatch reads as a diff. */
interface Rendered {
  name: string
  label: string
  caption: string
  boxes: string[]
  arrows: string[]
  notes: string[]
  frames: string[]
}

function pictures(chapter: string): Rendered[] {
  return [
    ...chapter.matchAll(
      /<figure class="vx-diagram\b[^"]*" data-picture="([^"]+)"[^>]*>([\s\S]*?)<\/figure>/g,
    ),
  ].map((m) => {
    const body = m[2]!
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
          `${decode(b[2]!)} ${b[1]}: ${decode(b[3]!).trim()}${b[4] === undefined ? '' : ` / ${decode(b[4]).trim()}`}`,
      ),
      arrows: [
        ...svg.matchAll(
          /<g class="arrow (\w+)" data-from="([^"]+)" data-to="([^"]+)">\s*<path\b[^>]*>(?:<\/path>)?\s*(?:<text\b[^>]*>([^<]*)<\/text>)?/g,
        ),
      ].map(
        (a) =>
          `${decode(a[2]!)} → ${decode(a[3]!)} ${a[1]}${a[4] === undefined ? '' : `: ${decode(a[4]).trim()}`}`,
      ),
      notes: [...svg.matchAll(/<text class="note\b[^"]*"[^>]*>([^<]*)<\/text>/g)].map((n) =>
        decode(n[1]!).trim(),
      ),
      frames: [
        ...svg.matchAll(
          /<g class="frame (\w+)">\s*<rect\b[^>]*>(?:<\/rect>)?\s*<text\b[^>]*>([^<]*)<\/text>/g,
        ),
      ].map((f) => `${f[1]}: ${decode(f[2]!).trim()}`),
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
    frames: (p.frames ?? []).map((f) => `${f.tone ?? 'default'}: ${f.label}`),
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
    const inVx = section(chapter, 'in-vx')
    const check = section(chapter, 'check-yourself')

    it('titles its sections with their point, then "In vx" and "Check yourself"', () => {
      expect(titles(chapter)).toEqual([...c.titles, 'In vx', 'Check yourself'])
    })

    it('draws at least three pictures, each named, captioned and as its data says', () => {
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
      const said = [...bare.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!))
      expect(said).toHaveLength(1)
      // A stop inside code (`vx.config.ts`) is followed by a letter, not a space.
      expect(said[0]!.split(/[.!?:](?:\s|$)/).filter((s) => s.trim() !== '')).toHaveLength(1)
      expect(bare.match(/<pre\b/g)).toHaveLength(1)
      expect(inVx.match(PROOFS)).toHaveLength(1)
      expect(inVx.trimEnd()).toMatch(/<\/details>$/)
    })

    it('links tests only from the proof list, and every link lands', () => {
      const proofs = links(only(inVx, PROOFS))
      const outside = links(prose(chapter).replace(PROOFS, ''))
      expect(outside.map((l) => l.href).filter((h) => h.startsWith('https://github.com/'))).toEqual(
        [],
      )
      const files = proofs.filter((l) => l.href.startsWith(GH)).map((l) => l.href.slice(GH.length))
      expect([...new Set(files)].sort()).toEqual(Object.keys(c.rows).sort())
      const all = [...proofs, ...outside]
      expect(all.map((l) => miss(c.slug, l, c.rows)).filter((m) => m !== undefined)).toEqual([])
    })

    it('asks one question, its answer collapsed', () => {
      const questions = [...prose(check).matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>/g)]
      const checkpoints = check.match(/<vx-checkpoint\b/g) ?? []
      expect(questions.length + checkpoints.length).toBe(1)
      for (const q of questions) expect(text(q[1]!)).toMatch(/\?$/)
    })

    it('names only the four toy packages', () => {
      // Tags become spaces: an SVG's texts sit side by side with none.
      const spaced = decode(prose(chapter).replace(/<[^>]+>/g, ' '))
      // Positive first: the chapter is about the four.
      expect(TOY.filter((p) => new RegExp(`\\b${p}\\b`).test(spaced))).not.toEqual([])
      expect(packagesNamed(spaced).filter((p) => !TOY.includes(p))).toEqual([])
    })

    it('names no other tool outside "In vx"', () => {
      // A widget is vx's own UI: the pipeline explorer names vx-migrate's turbo().
      const spaced = decode(
        prose(chapter)
          .replace(inVx, '')
          .replace(/<[^>]+>/g, ' '),
      )
      expect(spaced.match(COMPETITORS) ?? []).toEqual([])
      expect([...(text(inVx).match(COMPETITORS) ?? [])]).toEqual(c.inVxNames ?? [])
    })
  })
}

/** A chapter's `defineProject` block as the object it exports. The block is
 *  written with the import a reader copies; `defineProject` is the identity
 *  (schema.md § Project config), so the object is what vx reads. */
export function projectObject(block: string): string {
  const head = "import { defineProject } from '@vzn/vx'\n\nexport default defineProject("
  expect(block.startsWith(head)).toBe(true)
  expect(block.endsWith(')\n')).toBe(true)
  return block.slice(head.length, -2)
}

const SILENT: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const roots: string[] = []

/** The four packages, each with `config` (JavaScript source of the object
 *  its `vx.config.mjs` exports) and the dependencies `uses` gives it. */
export async function toyWorkspace(
  config: (pkg: string) => string,
  uses: Record<string, string[]> = TOY_USES,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-guide-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'toy', private: true, workspaces: ['packages/*'] }),
  )
  for (const [pkg, deps] of Object.entries(uses)) {
    const dir = path.join(root, 'packages', pkg)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: pkg,
        version: '0.0.0',
        dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
      }),
    )
    await writeFile(path.join(dir, 'vx.config.mjs'), `export default ${config(pkg)}\n`)
  }
  const git = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root, stderr: 'pipe' })
  if (git.exitCode !== 0) throw new Error(`git init: ${git.stderr.toString()}`)
  return root
}

export function plan(root: string, tasks: string[]): Promise<RunPlan> {
  return planRun({ cwd: root, tasks, log: SILENT })
}

export async function removeWorkspaces(): Promise<void> {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
}
