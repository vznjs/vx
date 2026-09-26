// What scripts/import-docs.ts makes of packages/vx/docs (item 837). The
// site's pins read the pages it writes, and held 2 of 34 mutations of it:
// a wrong link, a lost anchor, an unescaped placeholder or a dropped
// description reached the site with every row green. These hold the
// transforms one at a time, on small sources.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  GENERATED_MARK,
  buildLinkMap,
  cleanUrlFor,
  deriveDescription,
  designIndex,
  importDocs,
  outRelFor,
  transformFile,
} from '../scripts/import-docs.js'

const SOURCES = [
  'README.md',
  'architecture.md',
  'modules/README.md',
  'modules/index.md',
  'modules/cache.md',
  'design/roadmap-1.0.md',
  'design/pipeline.md',
]
const links = buildLinkMap(SOURCES)
/** The body transformFile writes for `text`, frontmatter dropped. */
const body = (srcRel: string, text: string): string =>
  transformFile(srcRel, `# T\n\n${text}\n`, links).split('---\n').slice(2).join('---\n').trim()

describe('where a source is served and written', () => {
  it('the three index pages have their own URLs and files; a slug drops punctuation', () => {
    expect(SOURCES.map(cleanUrlFor)).toEqual([
      'overview/',
      'architecture/',
      'modules/',
      'modules/public-surface/',
      'modules/cache/',
      'design/roadmap-10/',
      'design/pipeline/',
    ])
    expect(SOURCES.map(outRelFor)).toEqual([
      'overview.md',
      'architecture.md',
      'modules/index.md',
      'modules/public-surface.md',
      'modules/cache.md',
      'design/roadmap-1.0.md',
      'design/pipeline.md',
    ])
    expect(cleanUrlFor('Design/Upper.md')).toBe('design/upper/')
  })
})

describe('links', () => {
  it('an internal link becomes the clean URL, relative to the page, anchor and title kept', () => {
    expect(body('modules/cache.md', '[a](../architecture.md#keys "The keys")')).toBe(
      '[a](../../architecture/#keys "The keys")',
    )
    expect(body('architecture.md', '[c](./modules/cache.md)')).toBe('[c](../modules/cache/)')
  })

  it('`.` and `..` segments resolve; a directory link reaches its index page', () => {
    expect(body('design/pipeline.md', '[r](./../design/./roadmap-1.0.md)')).toBe(
      '[r](../../design/roadmap-10/)',
    )
    expect(body('architecture.md', '[m](./modules/) and [d](design/)')).toBe(
      '[m](../modules/) and [d](../design/)',
    )
  })

  it('external, protocol-relative, anchor-only and unknown links are left alone', () => {
    const text =
      '[e](https://x.test/a.md) [p](//architecture.md) [h](#here) [u](./nowhere.md) [s](STATUS.md)'
    expect(body('architecture.md', text)).toBe(text)
  })
})

describe('prose', () => {
  it('a placeholder is escaped in prose, not in a code span or a fence', () => {
    expect(body('architecture.md', 'under <cacheDir>, as `<cacheDir>/x`')).toBe(
      'under &lt;cacheDir&gt;, as `<cacheDir>/x`',
    )
    expect(body('architecture.md', '```sh\nls <cacheDir> # [x](./architecture.md)\n```')).toBe(
      '```sh\nls <cacheDir> # [x](./architecture.md)\n```',
    )
  })

  it('an unterminated code span is prose; a fence closes only on its own marker', () => {
    expect(body('architecture.md', 'a ` then <rel>')).toBe('a ` then &lt;rel&gt;')
    expect(body('architecture.md', '~~~\n```\n<x>\n~~~\n<y>')).toBe('~~~\n```\n<x>\n~~~\n&lt;y&gt;')
  })
})

describe('frontmatter', () => {
  it('the H1 becomes the title and leaves the body; a README with none is the Overview', () => {
    const page = transformFile('modules/cache.md', '# The `cache`\n\nBody text.\n', links)
    expect(page).toContain('title: "The cache"')
    expect(page.endsWith('---\nBody text.\n')).toBe(true)
    expect(transformFile('README.md', 'no heading here\n', links)).toContain('title: "Overview"')
  })

  it('the description and the edit link name the source', () => {
    const page = transformFile(
      'modules/cache.md',
      '# C\n\nThe local cache stores every artifact under its key.\n',
      links,
    )
    expect(page.split('\n').slice(0, 6)).toEqual([
      '---',
      GENERATED_MARK,
      'title: "C"',
      'description: "The local cache stores every artifact under its key."',
      'editUrl: "https://github.com/vznjs/vx/edit/main/packages/vx/docs/modules/cache.md"',
      '---',
    ])
  })

  it('the description skips lists, numbers, images and short lines, strips link markup, and is cut at a word', () => {
    expect(
      deriveDescription([
        '* a bullet that is long enough to be a description',
        '1. a numbered line that is long enough as well',
        '![an image](x.png) with a caption long enough',
        'too short',
        'See [the cache](./cache.md) for `<hash>` and **what it keeps** here.',
      ]),
    ).toBe('See the cache for hash and what it keeps here.')
    const long = `${'word '.repeat(40)}end`
    const cut = deriveDescription([long])
    expect([cut.length <= 158, cut.endsWith('word…')]).toEqual([true, true])
  })

  it('the design index lists its notes by title', () => {
    expect(
      designIndex([
        { url: 'design/b/', title: 'Beta' },
        { url: 'design/a/', title: 'Alpha' },
      ])
        .trimEnd()
        .split('\n')
        .slice(-2),
    ).toEqual(['- [Alpha](../design/a/)', '- [Beta](../design/b/)'])
  })
})

describe('a run', () => {
  it('clears generated pages a deleted source left, keeps authored ones, skips STATUS', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-import-docs-'))
    try {
      const docs = path.join(root, 'docs')
      const out = path.join(root, 'out')
      await mkdir(path.join(docs, 'modules'), { recursive: true })
      await mkdir(out, { recursive: true })
      await writeFile(path.join(docs, 'architecture.md'), '# Arch\n')
      await writeFile(path.join(docs, 'STATUS.md'), '# Status\n')
      await writeFile(path.join(out, 'gone.md'), `---\n${GENERATED_MARK}\ntitle: "Gone"\n---\n`)
      await writeFile(path.join(out, 'authored.md'), '---\ntitle: "Mine"\n---\n')
      expect(await importDocs(docs, out)).toBe(1)
      const listing = await Array.fromAsync(new Bun.Glob('**/*.md').scan({ cwd: out }))
      expect(listing.sort()).toEqual(['architecture.md', 'authored.md', 'design/index.md'])
      expect(await readFile(path.join(out, 'authored.md'), 'utf8')).toBe(
        '---\ntitle: "Mine"\n---\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
