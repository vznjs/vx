// The doc laws' Markdown reader (tests/helpers/markdown-anchors.ts), held
// on its own (item 842). The laws that use it pass on today's docs whether
// it reads every link or none: a reader that dropped each link's anchor
// left `doc-references` green while it checked no anchor at all.
import { describe, expect, it } from 'bun:test'
import { headingSlugs, proseLinks } from './helpers/markdown-anchors.js'

describe('heading slugs', () => {
  it('as github-slugger renders them, at every level, closing hashes dropped', () => {
    const md = [
      '# The Cache',
      '## `vx why` — a key, explained',
      '###### Deepest ##',
      '### v1.2: what moved?',
      'not # a heading',
    ].join('\n')
    expect([...headingSlugs(md)]).toEqual([
      'the-cache',
      'vx-why--a-key-explained',
      'deepest',
      'v12-what-moved',
    ])
  })

  it('a repeated heading is suffixed -1, -2 …', () => {
    expect([...headingSlugs('# Notes\n## Notes\n## Notes\n')]).toEqual([
      'notes',
      'notes-1',
      'notes-2',
    ])
  })

  it('a heading inside a fence is not one, however the fence is indented or spelled', () => {
    const md = [
      '# Real',
      '```sh',
      '# not a heading',
      '```',
      '  ~~~',
      '# nor this',
      '  ~~~',
      '## After',
    ].join('\n')
    expect([...headingSlugs(md)]).toEqual(['real', 'after'])
  })
})

describe('prose links', () => {
  it('a relative target and its anchor; a same-page anchor; no URL of any scheme', () => {
    const md =
      'See [a](cache.md#keys), [b](../cli.md), [c](#here), ' +
      '[d](https://x.test/a.md#y), [e](mailto:a@x.test) and [f](vscode:open).'
    expect(proseLinks(md)).toEqual([
      { target: 'cache.md', anchor: 'keys' },
      { target: '../cli.md', anchor: undefined },
      { target: '', anchor: 'here' },
    ])
  })

  it('a link quoted in a fence is not one', () => {
    expect(proseLinks('```md\n[x](gone.md#nope)\n```\n[y](here.md)')).toEqual([
      { target: 'here.md', anchor: undefined },
    ])
  })
})
