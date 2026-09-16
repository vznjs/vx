// The disk-full persona: a small file system named by `VX_SMALL_DISK` (CI
// mounts a 2 MiB tmpfs and sets it; so does the manual gate). Unsafe, i.e.
// outside the sandboxed shards: a sandboxed task sees a mount it did not
// make as read-only (EROFS on the first CI run, 2026-09-16), and a disk
// that cannot be written cannot be filled. Root is subject to ENOSPC like
// any user, so no user switch is needed. The gate is an env var CI sets,
// never a probe: absent, the suite skips on a laptop; on the machine whose
// result gates a merge it runs.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const SMALL = process.env['VX_SMALL_DISK']
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

// 700 KB of noise: zstd cannot shrink it, so the artifact needs that much room.
const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && head -c 700000 /dev/urandom > dist/out.bin' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

async function vx(
  cwd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
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

/** Write 256 KiB blocks into `dir` until the disk refuses one. */
async function fill(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await writeFile(path.join(dir, `filler-${i}.bin`), Buffer.alloc(256 * 1024, 1))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') return
      throw err
    }
  }
}

async function project(root: string): Promise<void> {
  await addProject(root, 'app', { config: CONFIG, files: { 'src/index.js': 'export {}\n' } })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

describe.skipIf(SMALL === undefined)('a full disk (VX_SMALL_DISK)', () => {
  const small = SMALL ?? ''
  const made: string[] = []
  afterEach(async () => {
    for (const f of await readdir(small))
      await rm(path.join(small, f), { recursive: true, force: true })
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
  })

  it(
    'a hit whose restore cannot write names the tree and the disk, not the artifact',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-full-ws-', dir: small })
      const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vx-full-cache-'))
      made.push(cacheDir)
      await project(root)
      const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      await rm(path.join(root, 'packages', 'app', 'dist'), { recursive: true, force: true })
      await fill(root)
      const second = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(second.code).toBe(1)
      expect(second.out + second.err).toMatch(
        /\[vx\] app#build: restore of [0-9a-f]+ into .* could not write its outputs \(ENOSPC: .*\)\. Free space on that disk and re-run\./,
      )
      expect(second.out + second.err).not.toContain('internal error')
      expect(second.out + second.err).not.toContain('corrupt artifact')
    },
    TIMEOUT,
  )

  it(
    'a finished run whose history cannot be recorded keeps its verdict',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-full-hist-' })
      made.push(root)
      const cacheDir = path.join(small, 'cache')
      await project(root)
      const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      await fill(small)
      // Reads only: no save, no memo, no eval store — the run record is the
      // one write left, and it is the last thing a run does.
      await writeFile(
        path.join(root, 'packages', 'app', 'src', 'index.js'),
        'export const changed = 1\n',
      )
      const second = await vx(root, [
        'run',
        'build',
        '--all',
        '--cache-dir',
        cacheDir,
        '--cache=local:r',
      ])
      expect(second.out + second.err).toContain('1 success')
      expect(second.out + second.err).toMatch(
        /\[vx\] run history not recorded: .*full.* — the verdict above stands/,
      )
      expect(second.out + second.err).not.toContain('\n    at ')
      expect(second.code).toBe(0)
    },
    TIMEOUT,
  )
})
