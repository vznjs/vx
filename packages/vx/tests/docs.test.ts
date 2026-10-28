// `vx docs`: the reference this version wrote, read from packages/vx/docs at
// its git tag on GitHub (nothing embedded), searched for the sections that
// hold every word, a heading match first.
import { describe, expect, it } from 'bun:test'
import { docsRef, loadPages, searchDocs } from '../src/cli/docs.js'
import { diskPages, docsIn } from './helpers/docs-pages.js'

const vx = (args: string[], load = diskPages) => docsIn(args, load)

describe('where the pages come from', () => {
  it('a release reads its own tag; a source checkout reads main', () => {
    expect([docsRef('0.0.641'), docsRef('0.0.0')]).toEqual(['v0.0.641', 'main'])
  })

  it('one listing of the docs folder at the ref, then each page of it, STATUS.md aside', async () => {
    const asked: Array<[string, string | undefined]> = []
    const get = async (url: string, init?: RequestInit): Promise<Response> => {
      asked.push([url, (init?.headers as Record<string, string> | undefined)?.['authorization']])
      if (url.startsWith('https://api.github.com/'))
        return Response.json([
          { name: 'cli.md', type: 'file' },
          { name: 'STATUS.md', type: 'file' },
          { name: 'modules', type: 'dir' },
          { name: 'notes.txt', type: 'file' },
        ])
      return new Response(`# ${url.split('/').pop()}`)
    }
    expect(await loadPages('v1.2.3', get, { GH_TOKEN: 't' })).toEqual({ cli: '# cli.md' })
    expect(asked).toEqual([
      ['https://api.github.com/repos/vznjs/vx/contents/packages/vx/docs?ref=v1.2.3', 'Bearer t'],
      ['https://raw.githubusercontent.com/vznjs/vx/v1.2.3/packages/vx/docs/cli.md', undefined],
    ])
  })

  it('a refused listing names what GitHub said', async () => {
    const get = async (): Promise<Response> => new Response('', { status: 403 })
    const err = await loadPages('v1.2.3', get, {}).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(String(err)).toContain('GitHub answered 403 listing packages/vx/docs at v1.2.3')
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

  it('a repeated heading links its own id, numbered as the site numbers it', () => {
    // cli.md repeats Usage, Options and Exit codes per verb; each link named
    // the first, and the site's forward sent it to `vx run`'s section.
    const page = {
      cli: [
        '# Commands',
        '## Run',
        '### Usage',
        'run usage',
        '##### Usage',
        'deep',
        '## Watch',
        '### Usage',
        'watch usage',
      ].join('\n'),
    }
    expect(searchDocs(page, ['usage'], 5).map((h) => [h.text.split('\n')[1], h.url])).toEqual([
      ['run usage', 'https://vznjs.github.io/vx/cli/#usage'],
      ['watch usage', 'https://vznjs.github.io/vx/cli/#usage-2'],
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
  it('prints the best sections as JSON', async () => {
    const r = await vx(['cache', 'inputs', '--limit', '2', '--format', 'json'])
    const doc = JSON.parse(r.out) as { query: string; hits: { page: string; url: string }[] }
    expect([r.code, doc.query, doc.hits.length]).toEqual([0, 'cache inputs', 2])
    const pages = Object.keys(await diskPages())
    for (const h of doc.hits) expect(pages).toContain(h.page)
  })

  it('--limit takes a plain whole number, and an empty one is missing', async () => {
    const errs = []
    for (const v of ['--limit=', '--limit=0x2', '--limit=1e1'])
      errs.push((await vx(['cache', v])).err)
    expect(errs.map((e) => e.split('\n')[0]!.trim())).toEqual([
      '✗ vx docs  --limit requires a value: a whole number above 0',
      '✗ vx docs  --limit takes a whole number above 0 (got 0x2)',
      '✗ vx docs  --limit takes a whole number above 0 (got 1e1)',
    ])
  })

  it('no match is an answer; no query is a usage refusal', async () => {
    const none = await vx(['zzqx'])
    expect([none.code, none.out.startsWith('vx docs: no section of the docs at ')]).toEqual([
      0,
      true,
    ])
    const bare = await vx(['--format', 'json'])
    expect([bare.code, JSON.parse(bare.out).error.code]).toEqual([1, 'VX_E_USAGE'])
  })

  it('no network is a refusal that names the site', async () => {
    const r = await vx(['cache', '--format', 'json'], async () => {
      throw new Error('Unable to connect')
    })
    const { error } = JSON.parse(r.out) as { error: { code: string; message: string } }
    expect([r.code, error.code]).toEqual([1, 'VX_E_NETWORK'])
    expect(error.message).toContain(
      '(Unable to connect); they are on the site, https://vznjs.github.io/vx/',
    )
  })
})
