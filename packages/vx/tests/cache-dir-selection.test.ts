// `--cache-dir` reaches every cache a run verb opens — the selection
// paths too. `--affected` owners, the picker and the watch sweep load the
// staged configs through the same evaluation cache a run uses; opening it
// at the workspace's default dir created `.vx/cache/cache.db` beside the
// one the user pointed at, and printed the schema notice against the
// wrong index.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { loadCliProjects } from '../src/cli/workspace-config.js'
import { listProjects, loadWorkspace } from '../src/workspace/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built' },
        cache: { inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] }, outputs: { files: [] } },
      },
    },
  }
`

// Root writes anywhere, so the case skips there; CI's runner is not root.
describe.skipIf(process.getuid?.() === 0)('a cache directory this user cannot write into', () => {
  let root: string
  let ro: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-cache-dir-ro-' })
    ro = await mkdtemp(path.join(os.tmpdir(), 'vx-ro-cache-'))
    await addProject(root, 'app', { config: CONFIG, files: { 'src/index.js': 'export {}\n' } })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    const { chmod, readdir } = await import('node:fs/promises')
    await chmod(ro, 0o755)
    for (const f of await readdir(ro)) await chmod(path.join(ro, f), 0o644)
    await rm(root, { recursive: true, force: true })
    await rm(ro, { recursive: true, force: true })
  })

  const vx = async (
    args: string[],
    cacheDir: string | null = ro,
  ): Promise<{ code: number; out: string; err: string }> => {
    const flags = cacheDir === null ? [] : ['--cache-dir', cacheDir]
    const proc = Bun.spawn([process.execPath, BIN, ...args, ...flags], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  }

  it(
    'fails the run once, before any task, naming the directory',
    async () => {
      // A first run creates the cache as this user; then the directory and
      // its files stop being writable, the way another user's `.vx` is.
      const first = await vx(['run', 'build', '--all'])
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      const { chmod, readdir } = await import('node:fs/promises')
      for (const f of await readdir(ro)) await chmod(path.join(ro, f), 0o444)
      await chmod(ro, 0o555)
      const second = await vx(['run', 'build', '--all'])
      expect(second.code).toBe(1)
      expect(second.err).toMatch(/cache directory .* is not writable \(/)
      expect(second.err).toMatch(/pass --cache-dir <path>/)
      // Not the per-task shape it had: no internal error, no task ran or failed.
      expect(second.out + second.err).not.toContain('internal error')
      expect(second.out + second.err).not.toContain('app#build')
    },
    TIMEOUT,
  )

  it(
    'a reader evaluates live on it and stores nothing',
    async () => {
      // `vx show` reads the workspace's own cache (it takes no --cache-dir),
      // so that is the directory that stops being writable here.
      const own = path.join(root, '.vx', 'cache')
      const first = await vx(['run', 'build', '--all'], null)
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      const { chmod, readdir } = await import('node:fs/promises')
      for (const f of await readdir(own)) await chmod(path.join(own, f), 0o444)
      await chmod(own, 0o555)
      try {
        // A changed config misses the evaluation cache AND the file-hash
        // memo, the two stores a reader would write; each is a quiet no-op.
        const config = path.join(root, 'packages', 'app', 'vx.config.mjs')
        await Bun.write(config, `${await Bun.file(config).text()}\n// changed\n`)
        const shown = await vx(['show'], null)
        expect(`${shown.code}\n${shown.err}`).toStartWith('0\n')
        expect(shown.out).toContain('app')
      } finally {
        await chmod(own, 0o755)
        for (const f of await readdir(own)) await chmod(path.join(own, f), 0o644)
      }
    },
    TIMEOUT,
  )

  it(
    'a prune is refused up front with the directory named; a dry run still reads',
    async () => {
      const first = await vx(['run', 'build', '--all'])
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      const { chmod, readdir } = await import('node:fs/promises')
      for (const f of await readdir(ro)) await chmod(path.join(ro, f), 0o444)
      await chmod(ro, 0o555)
      const pruned = await vx(['cache', 'prune', '--max-size', '1K'])
      expect(pruned.code).toBe(1)
      expect(pruned.err).toMatch(/^vx: cache directory .* is not writable \(EACCES: /)
      expect(pruned.err).not.toContain('\n    at ')
      const dry = await vx(['cache', 'prune', '--max-size', '1K', '--dry-run'])
      expect(`${dry.code}\n${dry.err}`).toStartWith('0\n')
    },
    TIMEOUT,
  )

  it(
    'a read-only checkout with no cache yet says so in one line, and so does a verb writing the tree',
    async () => {
      // The workspace root alone stops being writable: the cache directory
      // cannot be created under it, and neither can vx-lock.json.
      const { chmod } = await import('node:fs/promises')
      await chmod(root, 0o555)
      try {
        const shown = await vx(['show'], null)
        expect(shown.code).toBe(1)
        expect(shown.err).toMatch(/^vx: cannot create cache directory .*\.vx\/cache \(EACCES: /)
        expect(shown.err).toContain('--cache-dir <path>')
        expect(shown.err).not.toContain('\n    at ')
        const locked = await vx(['lock'], null)
        expect(locked.code).toBe(1)
        expect(locked.err).toMatch(
          /^vx: EACCES: permission denied, open '.*vx-lock\.json' — a path vx must write is not writable by this user\n$/,
        )
      } finally {
        await chmod(root, 0o755)
      }
    },
    TIMEOUT,
  )
})

describe('the run’s --cache-dir reaches selection', () => {
  let root: string
  let elsewhere: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-cache-dir-sel-' })
    elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-dir-elsewhere-'))
    await addProject(root, 'app', { config: CONFIG, files: { 'src/index.js': 'export {}\n' } })
    await Bun.write(path.join(root, 'shared', 'schema.json'), '{}')
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  })

  it('loadCliProjects opens the given dir, not the workspace default', async () => {
    const metas = await listProjects(await loadWorkspace(root))
    const staged = await loadCliProjects(root, metas, 'all', { cacheDir: elsewhere })
    expect([...staged.keys()]).toEqual(['app'])
    expect(existsSync(path.join(elsewhere, 'cache.db'))).toBe(true)
    expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
  })

  it(
    'an --affected run over an orphan change keeps every cache under --cache-dir',
    async () => {
      // An uncommitted edit to a path no project owns: `--affected` asks the
      // staged configs which task's workspaceFiles glob claims it.
      await Bun.write(path.join(root, 'shared', 'schema.json'), '{"v":2}')
      const proc = Bun.spawn(
        [process.execPath, BIN, 'run', 'build', '--filter', '[HEAD]', '--cache-dir', elsewhere],
        { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } },
      )
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(`${code}\n${err}${out}`).toStartWith('0\n')
      expect(out + err).toContain('app')
      expect(existsSync(path.join(elsewhere, 'cache.db'))).toBe(true)
      expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
    },
    TIMEOUT,
  )
})
