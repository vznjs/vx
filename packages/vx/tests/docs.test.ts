// `vx docs`: the reference searched offline. The corpus is the files on
// disk, which npm ships (tests/contract/pack/vx.txt); the search keeps the
// sections that hold every word and ranks a heading match first.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PAGES } from '../src/cli/docs-corpus.js'
import { searchDocs } from '../src/cli/docs.js'

const BIN = path.resolve(import.meta.dir, '../src/bin.ts')
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'docs', ...args], cwd: import.meta.dir })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('the corpus', () => {
  it('is each page as it is on disk', () => {
    for (const [page, text] of Object.entries(PAGES)) {
      expect(text).toBe(
        readFileSync(path.join(import.meta.dir, '..', 'docs', `${page}.md`), 'utf8'),
      )
    }
  })
})

describe('searchDocs', () => {
  const pages = {
    a: [
      'Intro names cache once.',
      '## Cache inputs',
      'Inputs are files.',
      '```sh',
      '# not a heading: cache inputs inputs inputs',
      '```',
      '## Other',
      'cache inputs cache inputs cache inputs cache inputs cache inputs',
    ].join('\n'),
    b: '# Only cache\nNo second word here.',
  }

  it('keeps sections holding every word, a heading match first', () => {
    expect(searchDocs(pages, ['cache', 'inputs'], 5).map((h) => [h.page, h.heading])).toEqual([
      ['a', 'Cache inputs'],
      ['a', 'Other'],
    ])
  })

  it('a fenced # line stays in its section, and the URL anchors the heading', () => {
    const [hit] = searchDocs(pages, ['heading'], 5)
    expect([hit!.heading, hit!.url]).toEqual([
      'Cache inputs',
      'https://vznjs.github.io/vx/a/#cache-inputs',
    ])
  })

  it('the opening is its page, and --limit cuts', () => {
    expect(searchDocs(pages, ['intro'], 5).map((h) => [h.heading, h.url])).toEqual([
      ['', 'https://vznjs.github.io/vx/a/'],
    ])
    expect(searchDocs(pages, ['cache'], 1)).toHaveLength(1)
  })
})

describe('vx docs', () => {
  it('prints the best sections as JSON, from the shipped reference', () => {
    const r = vx('cache', 'inputs', '--limit', '2', '--format', 'json')
    const doc = JSON.parse(r.out) as { query: string; hits: { page: string; url: string }[] }
    expect([r.code, doc.query, doc.hits.length]).toEqual([0, 'cache inputs', 2])
    for (const h of doc.hits) expect(Object.keys(PAGES)).toContain(h.page)
  })

  it('no match is an answer; no query is a usage refusal', () => {
    const none = vx('zzqx')
    expect([none.code, none.out.startsWith('vx docs: no section of cli, schema')]).toEqual([
      0,
      true,
    ])
    const bare = vx('--format', 'json')
    expect([bare.code, JSON.parse(bare.out).error.code]).toEqual([1, 'VX_E_USAGE'])
  })
})
