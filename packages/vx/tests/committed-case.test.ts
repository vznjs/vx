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

// A git that failed listed nothing, so every file read as uncommitted and an
// output clean could delete committed ones: the "never delete a committed
// file" check failed open (2026-10-28). It refuses instead.
describe('a git that cannot list the tracked files', () => {
  it('refuses, naming git, and an untracked directory lists nothing', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-committed-'))
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(['git', ...args], {
          cwd: root,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        })
      git('init', '-q')
      await mkdir(path.join(root, 'dist'))
      await writeFile(path.join(root, 'dist', 'keep.txt'), 'x')
      git('add', '.')
      const keep = path.join(root, 'dist', 'keep.txt')
      expect(new GitFilesCache().committedIn(path.join(root, 'dist'))(keep)).toBe(true)
      await writeFile(path.join(root, '.git', 'index'), 'not an index, but long enough to be read')
      let said: unknown
      try {
        new GitFilesCache().committedIn(path.join(root, 'dist'))(keep)
      } catch (err) {
        said = err
      }
      expect([(said as { code?: string })?.code, (said as Error)?.message]).toEqual([
        'VX_E_GIT',
        expect.stringContaining('git ls-files failed (exit 128)'),
      ])
      // CONTROL: outside a work tree nothing is tracked, as before.
      const bare = await mkdtemp(path.join(os.tmpdir(), 'vx-committed-bare-'))
      expect(new GitFilesCache().committedIn(bare)(path.join(bare, 'x'))).toBe(false)
      await rm(bare, { recursive: true, force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
