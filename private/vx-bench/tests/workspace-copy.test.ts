import { expect, it } from 'bun:test'
import { lstat, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { benchEnv } from '../bench-env.js'
import { copyWorkspace, outputMtimes } from '../workspace-copy.js'

const git = (args: string[], cwd: string): string => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=b@vx', '-c', 'user.name=b', ...args], {
    cwd,
    env: benchEnv(),
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString()
}

// pr-bench timed vx and Turbo in ONE workspace: Turbo rewrites every output
// on a warm hit, so vx's next "noop" found them changed and restored all 100.
it('copies a workspace whose git index vouches for every file, apart from the source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-copy-'))
  try {
    const src = path.join(root, 'a')
    await Bun.write(path.join(src, 'p', 'src', 'i.js'), 'x\n')
    git(['init', '-q'], src)
    git(['add', '-A'], src)
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'f'], src)
    const dst = path.join(root, 'b')
    copyWorkspace(src, dst)
    // A stale index stat would list the file here until git rehashed it.
    expect(git(['diff-files', '--name-only'], dst)).toBe('')
    expect(git(['status', '--porcelain'], dst)).toBe('')
    await writeFile(path.join(dst, 'p', 'src', 'i.js'), 'y\n')
    expect(await Bun.file(path.join(src, 'p', 'src', 'i.js')).text()).toBe('x\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// A copy refreshed in the second its files' ctimes fall in, over older
// mtimes, is an index git cannot see a same-second rewrite in (vx's
// `sameSecond`): vx then trusted none of its OIDs, which no checkout does.
it('refreshes the copy in a later second than its files were copied in', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-copy-racy-'))
  try {
    const src = path.join(root, 'a')
    const file = path.join(src, 'p', 'src', 'i.js')
    await Bun.write(file, 'x\n')
    await utimes(file, 1000, 1000)
    git(['init', '-q'], src)
    git(['add', '-A'], src)
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'f'], src)
    const dst = path.join(root, 'b')
    copyWorkspace(src, dst)
    const written = Math.floor((await lstat(path.join(dst, '.git', 'index'))).mtimeMs / 1000)
    const ctime = /^  ctime: (\d+):/m.exec(git(['ls-files', '--debug'], dst))
    // The entry was refreshed: it holds the copy's ctime, not the source's.
    expect(Number(ctime?.[1])).toBe(
      Math.floor((await lstat(path.join(dst, 'p', 'src', 'i.js'))).ctimeMs / 1000),
    )
    expect(Number(ctime?.[1])).toBeLessThan(written)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("reads every project's output mtimes, so a rewritten output shows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-mtimes-'))
  try {
    const out = path.join(root, 'packages', 'p', 'dist', 'out.js')
    await Bun.write(out, 'x')
    await utimes(out, 1000, 1000)
    const before = outputMtimes(root)
    expect(before).toEqual({ 'packages/p/dist/out.js': 1_000_000 })
    await utimes(out, 1000, 1001)
    expect(outputMtimes(root)).not.toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
