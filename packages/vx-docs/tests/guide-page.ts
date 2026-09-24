// What the Guide's chapter rows (guide-<slug>.test.ts) read from a built
// chapter: its HTML, its article, and the links a claim stands on. The
// chapters are the site's argument for vx, so each claim about vx links a
// test row, and a row here holds the link to it: the file exists and has a
// row with the title the link carries. The rows read `dist/`, which the
// `build` task writes.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'bun:test'

export const DIST = path.resolve(import.meta.dir, '../dist')
export const REPO = path.resolve(import.meta.dir, '../../..')
export const GH = 'https://github.com/vznjs/vx/blob/main/'
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

/** The four packages of the toy monorepo every chapter talks about. */
export const TOY = ['utils', 'ui', 'api', 'app']

export function page(slug: string): string {
  const file = path.join(DIST, slug, 'index.html')
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

/** The rows of a table's body: each row's cells as text, header cell first. */
export function tableRows(table: string): string[][] {
  const body = only(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1]!)),
  )
}

/** The chapter's prose and widgets: the page's Markdown content, without
 *  the page chrome around it (the title, the edit link). */
export function article(html: string): string {
  const main = only(html, /<main\b[^>]*>([\s\S]*)<\/main>/g)
  const start = main.indexOf('<div class="sl-markdown-content">')
  expect(start).toBeGreaterThan(-1)
  const end = main.indexOf('<footer', start)
  return main.slice(start, end === -1 ? undefined : end)
}

/** The article with the checkpoints cut out. A checkpoint lists every task
 *  of the playground's workspace, whose fifth package (`docs`) is chapter
 *  10's to settle; everything else on a chapter is held to the four. */
export function withoutCheckpoints(main: string): string {
  return main.replace(/<vx-checkpoint\b[\s\S]*?<\/vx-checkpoint>/g, '')
}

/** The chapter's section titles, as a skimming reader sees them. */
export function sectionTitles(main: string): string[] {
  return [...main.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]!))
}

/** The chapter's small pictures, by `data-diagram`, in page order. */
export function diagrams(main: string): string[] {
  return [...main.matchAll(/<figure class="vx-diagram"[^>]*data-diagram="([^"]+)"/g)].map(
    (m) => m[1]!,
  )
}

/** One picture's markup, from its `<figure>` to its `</figure>`. */
export function diagram(main: string, name: string): string {
  const figures = [
    ...main.matchAll(/<figure class="vx-diagram"[^>]*data-diagram="([^"]+)"[\s\S]*?<\/figure>/g),
  ].filter((m) => m[1] === name)
  expect(figures).toHaveLength(1)
  return figures[0]![0]
}

/** The words of the chapter's prose: its paragraphs outside a figure, a
 *  `<details>` and a code block. The simple-site brief's budget is 350. */
export function proseWords(main: string): number {
  const body = main.replace(/<(figure|details|pre)\b[\s\S]*?<\/\1>/g, '')
  return [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => words(m[1]!))
    .filter((t) => t !== '')
    .reduce((n, t) => n + t.split(' ').length, 0)
}

/** The collapsed proof list at the end of "In vx", and the article without it. */
export function proofs(main: string): { list: string; rest: string } {
  const re = /<details>\s*<summary>How we know this is true<\/summary>([\s\S]*?)<\/details>/g
  const list = only(main, re)
  return { list, rest: main.replace(re, '') }
}

/** Every package a text names: in a task id (`ui#build`) or a path
 *  (`packages/ui/…`, `ui/src/…`). */
export function packagesNamed(s: string): string[] {
  const names = new Set<string>()
  for (const m of s.matchAll(/(?<![\w@/.-])([a-z][\w-]*)#[a-z]/g)) names.add(m[1]!)
  for (const m of s.matchAll(/\bpackages\/([\w-]+)\//g)) names.add(m[1]!)
  for (const m of s.matchAll(/(?<![\w/.-])([a-z][\w-]*)\/(?:src|tsconfig\.json)\b/g)) {
    names.add(m[1]!)
  }
  return [...names].sort()
}

/** Every outside tool a chapter must not mention, as a reader would see it
 *  or as a link would reach it. */
export function competitorMentions(main: string): string[] {
  const named = [...words(main).matchAll(/\b(Turborepo|Turbo|turbo|Nx|nx|Bazel|bazel)\b/g)]
  const hosts = [
    ...main.matchAll(
      /href="https?:\/\/(?:www\.)?(turborepo\.com|turbo\.build|nx\.dev|bazel\.build)/g,
    ),
  ]
  return [...named, ...hosts].map((m) => m[1]!)
}

export interface Claim {
  href: string
  /** The link's title: the test row it stands for. */
  row: string | undefined
  label: string
}

/** Every link from the article into vx's repository. */
export function repoLinks(main: string): Claim[] {
  return [
    ...main.matchAll(/<a href="(https:\/\/github\.com\/vznjs\/vx\/[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g),
  ].map((m) => {
    const title = /\stitle="([^"]*)"/.exec(m[2]!)
    return { href: m[1]!, row: title === null ? undefined : decode(title[1]!), label: text(m[3]!) }
  })
}

/** Why a repository link does not stand on a test row; undefined when it does. */
export function missingRow(claim: Claim): string | undefined {
  if (!claim.href.startsWith(GH)) return `${claim.href} is not a file on main`
  const file = path.join(REPO, claim.href.slice(GH.length))
  if (!existsSync(file)) return `${claim.href} does not exist`
  if (claim.row === undefined) return `${claim.href} names no row`
  const source = readFileSync(file, 'utf8')
  return [`'${claim.row}'`, `"${claim.row}"`, `\`${claim.row}\``].some((q) => source.includes(q))
    ? undefined
    : `${claim.href} has no row "${claim.row}"`
}

/** The article's links to other pages of the site outside the Guide, as
 *  `slug#anchor`. */
export function siteLinks(main: string, slug: string): string[] {
  const from = new URL(`https://site${BASE}${slug}/`)
  return [...main.matchAll(/<a href="([^"#:]*\/[^"]*)"/g)]
    .map((m) => new URL(decode(m[1]!), from))
    .filter((u) => u.host === 'site' && !u.pathname.startsWith(`${BASE}guide/`))
    .map((u) => `${u.pathname.slice(BASE.length)}${u.hash}`)
}

/** Why a site link does not land; undefined when it does. */
export function missingPage(link: string): string | undefined {
  const [slug, anchor] = link.split('#') as [string, string | undefined]
  const file = path.join(DIST, slug, 'index.html')
  if (!existsSync(file)) return `no page: ${link}`
  if (anchor !== undefined && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
    return `no anchor: ${link}`
  }
  return undefined
}

/** Every `_astro/*.js` the page loads, followed through the chunks' own
 *  static and dynamic imports. Names only; the files sit in `dist/_astro/`. */
export function reachableScripts(html: string): Set<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const seen = new Set<string>()
  const queue = scripts.flatMap((s) =>
    [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
  )
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    // mermaid's chunks name files it never emits (`./elk-worker.min.js`).
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(m[1]!)
  }
  return seen
}

/** The page's scripts that define `<tag>`. */
export function defining(html: string, tag: string): string[] {
  const re = new RegExp(`customElements\\.define\\(\\s*["'\`]${tag}["'\`]`)
  return [...reachableScripts(html)].filter((name) =>
    re.test(readFileSync(path.join(DIST, '_astro', name), 'utf8')),
  )
}

/** The code blocks of the chapter's source, as written. */
export function codeBlocks(slug: string): string[] {
  const source = readFileSync(
    path.resolve(import.meta.dir, `../src/content/docs/guide/${slug}.mdx`),
    'utf8',
  )
  return [...source.matchAll(/```\w*\n([\s\S]*?)```/g)].map((m) => m[1]!)
}
