// "Never do anything twice" (owner, 2026-09-24), held as syscall COUNTS: a
// strace of each code path, filtered to the calls vx's own process makes
// on the paths it owns. Each row pins a repeat that was removed:
//
//   - the shell and git were looked up on PATH by every spawn (a stat per
//     PATH entry each time; 2,800 stats for `sh` on a 200-task run);
//   - opening the cache made the directory with `mkdir -p` and then asked
//     `access` whether it could write it, asked whether `cache.db` existed
//     before asking whether it was writable, and probed `.gitignore`
//     before creating it;
//   - releasing the run lock removed its directory with `rm -r`, an unlink
//     that fails EISDIR, an open and a listing before the rmdir;
//   - the workspace fingerprint stat'ed each file before reading it.
//
// Unsafe: strace ptraces its tracee, which a sandboxed shard cannot host.
// Linux only — strace is Linux's. CI's Linux job installs strace for the
// sandbox, and VX_REQUIRE_SANDBOX (set there) turns its absence into a
// failure instead of a skip.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn } from './helpers/workspace.js'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const TIMEOUT = 30_000

function required(): boolean {
  const v = process.env['VX_REQUIRE_SANDBOX']
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

const strace = process.platform === 'linux' ? Bun.which('strace') : null
if (process.platform === 'linux' && strace === null && required()) {
  throw new Error('syscall-repeats: strace is not on PATH and VX_REQUIRE_SANDBOX is set')
}

interface Call {
  name: string
  path: string
  args: string
}

/**
 * Run `script` (TypeScript, may import from `SRC`) under strace; return the
 * file-system calls of the bun process itself — every thread of it, and
 * none of the children it spawned (a process that went on to execve).
 */
async function trace(dir: string, script: string): Promise<Call[]> {
  const file = path.join(dir, `script-${Math.random().toString(36).slice(2)}.ts`)
  const log = `${file}.strace`
  await writeFile(file, script.replaceAll('$SRC', SRC))
  const p = Bun.spawnSync({
    cmd: [
      strace!,
      '-f',
      '-qq',
      '-s',
      '4096',
      '-e',
      'trace=%file,%process',
      '-o',
      log,
      process.execPath,
      file,
    ],
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(`${p.exitCode}\n${p.stderr.toString()}`).toStartWith('0\n')
  const lines = (await readFile(log, 'utf8')).split('\n')
  const root = /^(\d+)/.exec(lines[0]!)![1]!
  const children = new Set<string>()
  const parent = new Map<string, string>()
  for (const l of lines) {
    const m = /^(\d+)\s+(\w+)\(/.exec(l)
    if (m === null) continue
    if (m[2] === 'execve' && m[1] !== root) children.add(m[1]!)
    const r = /\) = (\d+)$/.exec(l)
    if (r !== null && ['vfork', 'clone', 'clone3', 'fork'].includes(m[2]!)) parent.set(r[1]!, m[1]!)
  }
  for (let grew = true; grew;) {
    grew = false
    for (const [c, p] of parent) {
      if (children.has(p) && !children.has(c)) {
        children.add(c)
        grew = true
      }
    }
  }
  const pending = new Map<string, string>()
  const calls: Call[] = []
  for (const l of lines) {
    const m = /^(\d+)\s+(.*)$/.exec(l)
    if (m === null || children.has(m[1]!)) continue
    let rest = m[2]!
    if (rest.endsWith('<unfinished ...>')) {
      pending.set(m[1]!, rest.slice(0, -'<unfinished ...>'.length))
      continue
    }
    const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(rest)
    if (resumed !== null) {
      rest = (pending.get(m[1]!) ?? `${resumed[1]}(`) + resumed[2]
      pending.delete(m[1]!)
    }
    const call = /^(\w+)\((?:AT_FDCWD, )?"([^"]*)"(.*)$/.exec(rest)
    if (call !== null) calls.push({ name: call[1]!, path: call[2]!, args: call[3]! })
  }
  return calls
}

/** The calls on `p`, named the way the kernel's variants mean them. */
function on(calls: readonly Call[], p: string): string[] {
  return calls
    .filter((c) => c.path === p)
    .map((c) => {
      if (c.name === 'faccessat' || c.name === 'faccessat2') return 'access'
      if (c.name === 'unlinkat') return c.args.includes('AT_REMOVEDIR') ? 'rmdir' : 'unlink'
      if (c.name === 'lstat' || /AT_SYMLINK_NOFOLLOW/.test(c.args)) return 'lstat'
      if (c.name === 'newfstatat' || c.name === 'statx' || c.name === 'fstatat64') return 'stat'
      return c.name
    })
}

/** Lookups a PATH walk makes: a stat or access probe of `<dir>/<name>`. */
function lookups(calls: readonly Call[], name: string): number {
  return calls.filter(
    (c) =>
      c.path.endsWith(`/${name}`) &&
      /^(stat|lstat|newfstatat|statx|access|faccessat2?)$/.test(c.name),
  ).length
}

describe.skipIf(strace === null)('what vx asks the kernel once', () => {
  let dir: string

  beforeAll(async () => {
    // Canonical: strace prints the paths the script passes, and the script
    // derives them from this.
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-syscalls-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it(
    'opening the cache: one access each for the directory and the database, one exclusive create for .gitignore',
    async () => {
      const cacheDir = path.join(dir, 'open', '.vx', 'cache')
      await mkdir(path.dirname(path.dirname(cacheDir)))
      const script = `
        import { Cache } from '$SRC/cache/index.js'
        new Cache(${JSON.stringify(cacheDir)}).close()
      `
      const cold = await trace(dir, script)
      const warm = await trace(dir, script)
      const vxOwn = (calls: Call[], p: string): string[] =>
        on(calls, p).filter((n) => n !== 'lstat' && n !== 'openat' && n !== 'stat')
      // A cold open makes the directory (the recursive mkdir asks the leaf
      // before its parent) and knows the rest: an empty directory it made
      // holds no database and no ignore file.
      expect(vxOwn(cold, cacheDir)).toEqual(['access', 'mkdir', 'mkdir'])
      expect(vxOwn(cold, path.join(cacheDir, 'cache.db'))).toEqual([])
      expect(on(cold, path.join(cacheDir, '.gitignore'))).toEqual(['openat'])
      // A warm open: no mkdir, no existence probe before the write probe.
      expect(vxOwn(warm, cacheDir)).toEqual(['access'])
      expect(vxOwn(warm, path.join(cacheDir, 'cache.db'))).toEqual(['access'])
      const ignore = warm.filter((c) => c.path === path.join(cacheDir, '.gitignore'))
      expect(ignore.map((c) => c.name)).toEqual(['openat'])
      expect(ignore[0]!.args).toContain('O_EXCL')
      expect(ignore[0]!.args).toContain('EEXIST')
    },
    TIMEOUT,
  )

  it(
    'releasing the run lock: the pid file and the directory, one call each',
    async () => {
      const locks = path.join(dir, 'locks')
      await mkdir(locks)
      const calls = await trace(
        dir,
        `
        import { acquireRunLock, runLockPath } from '$SRC/orchestrator/run-lock.js'
        const release = await acquireRunLock('/ws', { dir: ${JSON.stringify(locks)}, log: () => {} })
        await release()
        `,
      )
      const { runLockPath } = await import('../src/orchestrator/run-lock.js')
      const lockDir = runLockPath('/ws', locks)
      expect(on(calls, lockDir)).toEqual(['mkdir', 'rmdir'])
      // Written at acquire, read back at release: the read is the proof no
      // other run reclaimed the lock, not a repeat (run-lock.ts).
      expect(on(calls, path.join(lockDir, 'pid'))).toEqual(['openat', 'openat', 'unlink'])
    },
    TIMEOUT,
  )

  it(
    'the workspace fingerprint: one call per candidate file, present or absent',
    async () => {
      const root = path.join(dir, 'fp')
      await mkdir(root)
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
      await writeFile(path.join(root, 'bun.lock'), '{}\n')
      const calls = await trace(
        dir,
        `
        import { computeWorkspaceFingerprints } from '$SRC/workspace/index.js'
        await computeWorkspaceFingerprints(${JSON.stringify(root)}, new Set())
        `,
      )
      const { WORKSPACE_FINGERPRINT_FILES } = await import('../src/workspace/fingerprint.js')
      expect(WORKSPACE_FINGERPRINT_FILES.length).toBeGreaterThan(2)
      for (const f of WORKSPACE_FINGERPRINT_FILES) {
        expect([f, on(calls, path.join(root, f))]).toEqual([f, ['openat']])
      }
    },
    TIMEOUT,
  )

  it(
    'the task shell is looked up once per process, not once per task',
    async () => {
      const bin = path.join(dir, 'proj', 'node_modules', '.bin')
      await mkdir(bin, { recursive: true })
      const tasks = (n: number): string => `
        import { runCommand } from '$SRC/exec/runner.js'
        const env = { PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH }
        for (let i = 0; i < ${n}; i++) {
          const r = await runCommand({ command: 'true', cwd: ${JSON.stringify(dir)}, env })
          if (r.exitCode !== 0) throw new Error('task failed')
        }
      `
      const one = lookups(await trace(dir, tasks(1)), 'sh')
      const four = lookups(await trace(dir, tasks(4)), 'sh')
      expect(one).toBeGreaterThan(0)
      expect(four).toBe(one)
    },
    TIMEOUT,
  )

  it(
    'git is looked up once per process, not once per spawn',
    async () => {
      const repo = path.join(dir, 'repo')
      await mkdir(repo)
      gitIn(repo)('init', '-q')
      const spawns = (n: number): string => `
        import { runGitLsFiles } from '$SRC/cache/git-inputs.js'
        for (let i = 0; i < ${n}; i++) runGitLsFiles(${JSON.stringify(repo)})
      `
      const one = lookups(await trace(dir, spawns(1)), 'git')
      const three = lookups(await trace(dir, spawns(3)), 'git')
      expect(one).toBeGreaterThan(0)
      expect(three).toBe(one)
    },
    TIMEOUT,
  )
})
