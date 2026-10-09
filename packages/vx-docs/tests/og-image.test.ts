// M, 2026-10-09: a shared blog or release link must show its own banner,
// not the site's. Every built post and release page names an absolute
// og:image that is not the site default, and the image ships in the build.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '..', 'dist')
const SITE = 'https://vznjs.github.io/vx/'

function pages(section: string): string[] {
  return readdirSync(path.join(DIST, section), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^\d+$/.test(e.name))
    .map((e) => path.join(DIST, section, e.name, 'index.html'))
    .filter((f) => existsSync(f) && !readFileSync(f, 'utf8').includes('http-equiv="refresh"'))
}

describe('link previews', () => {
  it('every post and release page has its own og:image in the build', () => {
    const bad: string[] = []
    const all = [...pages('blog'), ...pages('releases')]
    for (const file of all) {
      const html = readFileSync(file, 'utf8')
      const og = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1]
      const card = /<meta name="twitter:card" content="summary_large_image"/.test(html)
      const rel = path.relative(DIST, file)
      if (!og || !card || !og.startsWith(SITE) || og === `${SITE}og.png`) bad.push(`${rel}: ${og}`)
      else if (!existsSync(path.join(DIST, og.slice(SITE.length))))
        bad.push(`${rel}: ${og} not built`)
    }
    expect(all.length).toBeGreaterThan(60)
    expect(bad).toEqual([])
  })
})
