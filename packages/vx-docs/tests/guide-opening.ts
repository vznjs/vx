// What the Guide's first three chapters' rows share (guide-why, guide-tasks,
// guide-dependencies): the built page and its prose, the four toy packages,
// the claim links, the chapter's own code blocks, and a real toy workspace
// that vx plans, so a chapter's "In vx" config is held to what vx does with
// it rather than to what the page says it does.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends on
// `build` for that reason.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'bun:test'
import { planRun, type Logger, type RunPlan } from '@vzn/vx'
import type { Picture } from '../src/components/guide/diagram.js'

export const DIST = path.resolve(import.meta.dir, '../dist')
const DOCS = path.resolve(import.meta.dir, '../src/content/docs')
const REPO = path.resolve(import.meta.dir, '../../..')
const GH = 'https://github.com/vznjs/vx/blob/main/'
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const SITE = new URL(BASE, process.env['SITE_URL'] ?? 'https://vznjs.github.io').href

/** The running example, written out by hand: package → the packages it uses. */
export const TOY: Record<string, string[]> = {
  utils: [],
  ui: ['utils'],
  api: ['utils'],
  app: ['ui', 'api'],
}

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

export function unescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function text(html: string): string {
  return unescape(
    html
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

/** What the chapter itself says: Starlight's rendered Markdown, without the
 *  site's header, sidebar, table of contents, footer and the layout's own
 *  chapter header and Next card, which name other pages. */
export function content(html: string): string {
  const open = '<div class="sl-markdown-content">'
  const start = html.indexOf(open)
  expect(start).toBeGreaterThan(-1)
  expect(html.indexOf(open, start + 1)).toBe(-1)
  let depth = 0
  for (const m of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += m[1] === '/' ? -1 : 1
    if (depth === 0) return html.slice(start + open.length, start + m.index!)
  }
  throw new Error('the Markdown content never closes')
}

/** The package names a page's HTML uses: the package of every `pkg#task`
 *  but the notation's own `package#task`, and the first segment of every
 *  `packages/<name>` or `<name>/src/`, `<name>/dist/` path. Tags become
 *  spaces, so two table cells never read as one word. */
export function packageNames(html: string): string[] {
  const prose = unescape(html.replace(/<[^>]+>/g, ' '))
  const names = new Set<string>()
  for (const m of prose.matchAll(/(?<![\w/.-])([a-z][\w-]*)#([a-z]\w*)/g)) {
    if (`${m[1]}#${m[2]}` !== 'package#task') names.add(m[1]!)
  }
  for (const m of prose.matchAll(/\bpackages\/([a-z][\w-]*)/g)) names.add(m[1]!)
  for (const m of prose.matchAll(/(?<![\w/.-])([a-z][\w-]*)\/(?:src|dist)\//g)) names.add(m[1]!)
  return [...names].sort()
}

/** The chapter's section titles, in order. */
export function sectionTitles(html: string): string[] {
  return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]!))
}

/** The picture ids of the chapter's diagrams, in order. */
export function diagrams(html: string): string[] {
  return [...html.matchAll(/<figure class="vx-diagram\b[^"]*"[^>]*data-picture="([^"]+)"/g)].map(
    (m) => m[1]!,
  )
}

/** One diagram's markup, by picture id. */
export function diagram(html: string, id: string): string {
  return only(
    html,
    new RegExp(
      `(<figure class="vx-diagram\\b[^"]*"[^>]*data-picture="${id}"[\\s\\S]*?</figure>)`,
      'g',
    ),
  )
}

/** The page draws exactly these pictures, in order: each an image named by
 *  its label, with every box its data holds, and a caption. */
export function expectDiagrams(html: string, expected: Picture[]): void {
  expect(diagrams(html)).toEqual(expected.map((p) => p.id))
  for (const p of expected) {
    const figure = diagram(html, p.id)
    expect(unescape(only(figure, /<svg\b[^>]*role="img" aria-label="([^"]*)"/g))).toBe(p.label)
    expect([...figure.matchAll(/data-box="([^"]+)"/g)].map((m) => unescape(m[1]!))).toEqual(
      p.boxes.map((b) => b.id),
    )
    expect(text(only(figure, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).not.toBe('')
  }
}

/** The summaries of the page's collapsed blocks, in order. */
export function summaries(html: string): string[] {
  return [...html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => text(m[1]!))
}

/** The words of the chapter's prose: its paragraphs outside pictures, code
 *  and collapsed blocks. The owner's budget is about 300. */
export function proseWords(html: string): number {
  const bare = html
    .replace(/<figure\b[\s\S]*?<\/figure>/g, ' ')
    .replace(/<details\b[\s\S]*?<\/details>/g, ' ')
    .replace(/<pre\b[\s\S]*?<\/pre>/g, ' ')
  return [...bare.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => text(m[1]!))
    .join(' ')
    .split(/\s+/)
    .filter((w) => w !== '').length
}

const PROOF_SUMMARY = 'How we know this is true'

/** The links in the one collapsed "How we know this is true" list, and the
 *  links everywhere else. Test and reference links live only in the list. */
export function proofLinks(html: string): { proofs: Link[]; elsewhere: Link[] } {
  const blocks = [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].filter(
    (m) => text(only(m[1]!, /<summary\b[^>]*>([\s\S]*?)<\/summary>/g)) === PROOF_SUMMARY,
  )
  expect(blocks).toHaveLength(1)
  return {
    proofs: links(blocks[0]![1]!),
    elsewhere: links(html.replace(blocks[0]![0], ' ')),
  }
}

/** The teaching pictures: an SVG that is an image with a name. Starlight's
 *  heading anchors and icons are SVG too, and are no picture. */
export function pictures(html: string): string[] {
  return [...html.matchAll(/(<svg\b[^>]*\brole="img"[\s\S]*?<\/svg>)/g)].map((m) => m[1]!)
}

/** Every package the prose names is one of the four. */
export function expectOnlyToyPackages(html: string, found = packageNames(html)): void {
  // Positive first: the page names packages the reader can find.
  expect(found.length).toBeGreaterThan(0)
  expect(found.filter((n) => !(n in TOY))).toEqual([])
}

/** Other task runners, by every name a reader would recognise. */
export const COMPETITORS = /\b(turbo(repo)?|nx|nrwl|bazel)\b/i

export interface Link {
  href: string
  /** The link's text, tags stripped. */
  label: string
}

/** The links the prose makes; Starlight's own anchor beside each heading
 *  is not one. */
export function links(html: string): Link[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((m) => !/\bclass="sl-anchor-link"/.test(m[1]!))
    .map((m) => ({ href: unescape(/\bhref="([^"]*)"/.exec(m[1]!)![1]!), label: text(m[2]!) }))
}

/** Why a link on `slug`'s page does not hold its claim; undefined when it
 *  does. A site link names a built page and, with a fragment, an id on it.
 *  A link to a test file on GitHub names the row in its text (`the row
 *  "…"`), and the file in this checkout holds a row by that title. */
export function missing(slug: string, link: Link): string | undefined {
  if (link.href.startsWith(GH)) {
    const file = path.join(REPO, link.href.slice(GH.length))
    if (!existsSync(file)) return `${link.href}: no such file`
    // The Markdown renderer curls the quotes.
    const row = /^the row ["“](.+)["”]$/.exec(link.label)?.[1]
    if (row === undefined) return `${link.href}: the text names no row: ${link.label}`
    const body = readFileSync(file, 'utf8')
    if (!body.includes(`it('${row}'`) && !body.includes(`it("${row}"`)) {
      return `${link.href}: no row '${row}'`
    }
    return undefined
  }
  const url = new URL(link.href, `${SITE}${slug}/`)
  if (!url.href.startsWith(SITE)) return `${link.href}: outside the site`
  const rel = decodeURIComponent(url.pathname.slice(new URL(SITE).pathname.length))
  const file = path.join(DIST, rel.endsWith('/') || rel === '' ? `${rel}index.html` : rel)
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    return `${link.href}: no page`
  }
  const id = decodeURIComponent(url.hash.slice(1))
  if (id !== '' && !readFileSync(file, 'utf8').includes(`id="${id}"`)) {
    return `${link.href}: no id ${id}`
  }
  return undefined
}

/** The chapter's fenced code blocks of one language (`''` for a bare
 *  fence), from its source, in order. */
export function codeBlocks(slug: string, lang: string): string[] {
  const source = readFileSync(path.join(DOCS, `${slug}.mdx`), 'utf8')
  const blocks: { lang: string; body: string }[] = []
  let open: { lang: string; body: string } | undefined
  for (const line of source.split('\n')) {
    if (open === undefined) {
      const fence = /^```(\w*)$/.exec(line)
      if (fence !== null) open = { lang: fence[1]!, body: '' }
    } else if (line === '```') {
      blocks.push(open)
      open = undefined
    } else {
      open.body += `${line}\n`
    }
  }
  expect(open).toBeUndefined()
  return blocks.filter((b) => b.lang === lang).map((b) => b.body)
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
  uses: Record<string, string[]> = TOY,
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
