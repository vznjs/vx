// What deploy.github (scripts/release-sync.ts) gives each GitHub release.
import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { postNotes } from '../node_modules/@vzn/vx/scripts/release-notes.ts'
import { postFile, stale } from '../scripts/release-sync.ts'

describe('stale', () => {
  const post = "---\ntitle: 'T'\n---\nBody.\n"
  const want = postNotes(post, '0.0.3')

  it('rewrites only a release whose post says something else', () => {
    expect(
      stale(
        [
          { id: 1, tag_name: 'v0.0.1', body: 'changelog' },
          { id: 2, tag_name: 'v0.0.2', body: 'changelog' },
          { id: 3, tag_name: 'v0.0.3', body: want.replaceAll('\n', '\r\n') },
        ],
        (v) => (v === '0.0.1' ? undefined : post),
      ).map((r) => r.id),
    ).toEqual([2])
  })

  it("finds a release's post among this site's pages", () => {
    expect(existsSync(postFile('0.0.637'))).toBe(true)
  })
})
