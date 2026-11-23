// The site as markdown for agents (src/llms/pages.ts): each `.md` page's
// links reach another `.md` page, and llms.txt walks the docs in the
// sidebar's reading order.
import { describe, expect, it, mock } from 'bun:test'

await mock.module('astro:content', () => ({ getCollection: async () => [] }))
const { pageMarkdown, readingOrder } = await import('../src/llms/pages.ts')
type Page = Parameters<typeof pageMarkdown>[0]

const BASE = 'https://vznjs.github.io/vx/'
const page = (id: string, body = ''): Page =>
  ({ id, body, data: { title: id, description: '' } }) as unknown as Page
const ids = new Set(['docs/ci', 'docs/troubleshooting', 'cli', 'quickstart', 'docs/agents', 'docs'])

describe('a page as markdown', () => {
  it('points a relative link at the linked page`s markdown, from one level up', () => {
    // Written for the HTML at docs/troubleshooting/: from the .md beside it,
    // `../ci/` was vx/ci/, a 404.
    const md = pageMarkdown(
      page('docs/troubleshooting', 'See [CI](../ci/#common-problems) and [cli](../../cli/).'),
      BASE,
      ids,
    )
    expect(md).toContain(`[CI](${BASE}docs/ci.md#common-problems)`)
    expect(md).toContain(`[cli](${BASE}cli.md)`)
  })

  it('leaves a page with no markdown, a fence and an outside link as they are', () => {
    const md = pageMarkdown(
      page(
        'docs/ci',
        '[scores](../../conformance/) [gh](https://github.com/vznjs/vx)\n```ts\nx[0](../a/)\n```\n',
      ),
      BASE,
      ids,
    )
    expect(md).toContain(`[scores](${BASE}conformance/)`)
    expect(md).toContain('[gh](https://github.com/vznjs/vx)')
    expect(md).toContain('x[0](../a/)')
  })

  it('spells MDX components as markdown', () => {
    const md = pageMarkdown(
      page(
        'docs/agents',
        'import { Aside, CardGrid, LinkCard } from \'@astrojs/starlight/components\'\n\n<Aside type="tip" title="Hint">\n  text\n</Aside>\n\n<CardGrid>\n  <LinkCard title="CI" description="Run on CI." href="../ci/" />\n</CardGrid>\n',
      ),
      BASE,
      ids,
    )
    expect(md).not.toMatch(/import |<\/?(Aside|CardGrid|LinkCard)/)
    expect(md).toContain('**Hint**')
    expect(md).toContain(`- [CI](${BASE}docs/ci.md): Run on CI.`)
  })
})

describe('the reading order', () => {
  it('opens with the quickstart and leaves the blog out', () => {
    const order = readingOrder([page('docs/ci'), page('blog/x'), page('quickstart'), page('docs')])
    expect(order[0]![0]).toBe('Start here')
    expect(order[0]![1].map((p) => p.id)).toEqual(['docs', 'quickstart'])
    expect(order.flatMap(([, ps]) => ps.map((p) => p.id))).not.toContain('blog/x')
  })
})
