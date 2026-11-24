// The disk-full persona: a 2 MiB tmpfs that fills. Bubblewrap mounts one
// with no privilege (`--size` + `--tmpfs`), and this file runs itself again
// inside it with `VX_SMALL_DISK` naming it; CI's runners needed a sudo mount
// step before (2026-10-23: "can we do this test without this
// mount?"). Unsafe, i.e. outside the sandboxed shards: a sandboxed task
// sees a mount it did not make as read-only (EROFS on the first CI run,
// 2026-09-16). Root is subject to ENOSPC like any user. Without bwrap the
// suite skips, except where VX_REQUIRE_SANDBOX (CI) makes that a failure:
// a skip is a silent pass on the machine whose result gates a merge.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { vx } from './helpers/vx.js'

const SMALL = process.env['VX_SMALL_DISK']
const BWRAP = Bun.which('bwrap')
const TIMEOUT = 30_000

// 700 KB of noise: zstd cannot shrink it, so the artifact needs that much room.
const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && head -c 700000 /dev/urandom > dist/out.bin' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
    },
  }
`

/** Write `block`-byte files into `dir` until the disk refuses one. */
async function fill(dir: string, block = 256 * 1024): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await writeFile(path.join(dir, `filler-${block}-${i}.bin`), Buffer.alloc(block, 1))
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

describe.skipIf(
  SMALL !== undefined ||
    process.platform !== 'linux' ||
    (BWRAP === null && process.env['VX_REQUIRE_SANDBOX'] !== '1'),
)('a full disk, in a 2 MiB tmpfs bubblewrap mounts', () => {
  it(
    'runs every case below on it, none skipped',
    async () => {
      expect(BWRAP).not.toBeNull()
      const mount = await mkdtemp(path.join(os.tmpdir(), 'vx-small-'))
      try {
        const proc = Bun.spawn(
          [
            BWRAP!,
            '--dev-bind',
            '/',
            '/',
            '--size',
            String(2 * 1024 * 1024),
            '--tmpfs',
            mount,
            process.execPath,
            'test',
            import.meta.path,
          ],
          {
            cwd: path.resolve(import.meta.dir, '..'),
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, VX_SMALL_DISK: mount },
          },
        )
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        expect(`${code}\n${out}${err}`).toStartWith('0\n')
        expect(err).toMatch(/\b5 pass\b/)
        // The one skip is this wrapper, inside.
        expect(err).toMatch(/\b1 skip\b/)
      } finally {
        await rm(mount, { recursive: true, force: true })
      }
    },
    3 * TIMEOUT,
  )
})

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
    'a restore the full disk refuses leaves the outputs it found as they were',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-full-keep-', dir: small })
      const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vx-full-cache-'))
      made.push(cacheDir)
      await project(root)
      const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      // Small, so removing it first would not make the entry's room.
      const out = path.join(root, 'packages', 'app', 'dist', 'out.bin')
      await writeFile(out, 'old\n')
      await fill(root)
      const second = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(second.out + second.err).toContain('ENOSPC')
      expect(second.code).toBe(1)
      expect(await readFile(out, 'utf8')).toBe('old\n')
    },
    TIMEOUT,
  )

  it(
    'a save the disk fills mid-write leaves no entry a later run hits',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-full-save-' })
      made.push(root)
      const cacheDir = path.join(small, 'cache')
      await project(root)
      const run = () => vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      const first = await run()
      expect(`${first.code}\n${first.err}`).toStartWith('0\n')
      await writeFile(
        path.join(root, 'packages', 'app', 'src', 'index.js'),
        'export const changed = 1\n',
      )
      await fill(small)
      // 256 KiB of room: the 700 KB artifact starts, and the disk ends it.
      await rm(path.join(small, `filler-${256 * 1024}-0.bin`))
      const full = await run()
      expect(full.out + full.err).toMatch(/cache save failed: app#build: .*(ENOSPC|full)/)
      expect(full.code).toBe(0)
      for (const f of await readdir(small))
        if (f.startsWith('filler-')) await rm(path.join(small, f))
      await rm(path.join(root, 'packages', 'app', 'dist'), { recursive: true, force: true })
      const after = await run()
      expect(`${after.code}\n${after.out}`).toMatch(/^0\n[\s\S]*1 success/)
      expect(after.out).not.toContain('restored')
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
        '--cache-policy=local:r',
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

  it(
    'a cache directory made on a full disk names the file it could not write',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-full-dir-' })
      made.push(root)
      await project(root)
      const cacheDir = path.join(small, 'cache')
      await fill(small)
      // Down to the last page: the ignore file's two bytes are refused too.
      await fill(small, 512)
      const run = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(run.code).toBe(1)
      expect(run.out + run.err).toContain(
        `ENOSPC: no space left on device, write '${path.join(cacheDir, '.gitignore')}'`,
      )
      expect(run.out + run.err).toContain('the disk that path is on is full')
      // An empty ignore file left behind would stand as written to every later run.
      expect(await readdir(cacheDir)).not.toContain('.gitignore')
    },
    TIMEOUT,
  )
})
