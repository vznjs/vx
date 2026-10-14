import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { GitFilesCache } from '../src/cache/index.js'

describe('a committed file is told by path as git compares it', () => {
  const dir = path.resolve('/w/app')
  const committed = (ignorecase: string) => {
    const cache = new GitFilesCache()
    cache.setGitVars(`core.ignorecase=${ignorecase}\n`)
    cache.noteTracked([dir], [path.join(dir, 'data/Sponsors.json')])
    return cache.committedIn(dir)
  }

  it('under core.ignorecase, a case-only rename git never saw is still committed', () => {
    // macOS: renamed in Finder, git still lists `Sponsors.json`, the disk walk
    // finds `sponsors.json`; the clean deleted it.
    expect(committed('true')(path.join(dir, 'data/sponsors.json'))).toBe(true)
  })

  it('on a case-sensitive repository the two names are two files', () => {
    expect(committed('false')(path.join(dir, 'data/sponsors.json'))).toBe(false)
  })
})
