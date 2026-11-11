// `local()`: workers as processes on this machine, each in its own git
// worktree of the working tree's tracked state, and a relay of its own on
// loopback. For tests, demos
// and trying a distributed run before a CI starts the workers.

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { refuseUnknownOptions, type PluginOptionKinds } from '@vzn/vx'
import type { DteAdapter } from './plugin.js'

export interface LocalOptions {
  /** A shell line each worktree runs before its worker starts, such as `bun install`. */
  readonly prepare?: string
}

const KEYS: PluginOptionKinds<LocalOptions> = { prepare: 'string' }

export function local(options: LocalOptions = {}): DteAdapter {
  refuseUnknownOptions('local()', options, KEYS)
  let relay: { url: string; stop(): void } | undefined
  let base: Promise<string> | undefined
  let closed = false
  const procs = new Set<Bun.Subprocess>()
  /** A worktree add or a prepare: what close stops at once. */
  const helpers = new Set<Bun.Subprocess>()
  /** The repositories this run adds worktrees to, whose records close prunes. */
  const roots = new Set<string>()
  const pending = new Set<Promise<unknown>>()

  // Async throughout: a run starts its workers while it shows its first rows.
  const start = <P extends Bun.Subprocess>(p: P): P => {
    procs.add(p)
    void p.exited.then(() => procs.delete(p))
    return p
  }
  const run = async (
    argv: string[],
    cwd: string,
    env?: Record<string, string | undefined>,
    helper = true,
    // A prepare's reason can be on stdout: pnpm prints its install errors there.
    stdout = false,
  ) => {
    const p = start(
      Bun.spawn(argv, {
        cwd,
        env: env ?? process.env,
        stdin: 'ignore',
        stdout: stdout ? 'pipe' : 'ignore',
        stderr: 'pipe',
        // Its own group, which close signals whole: SIGTERM to the shell
        // alone left the install it started writing into a removed tree.
        detached: helper,
      }),
    )
    if (helper) {
      helpers.add(p)
      void p.exited.then(() => helpers.delete(p))
    }
    const chunks: Uint8Array[] = []
    const read = async (from: ReadableStream<Uint8Array>) => {
      for await (const c of from) chunks.push(c)
    }
    const reading = Promise.all([
      read(p.stderr),
      p.stdout instanceof ReadableStream ? read(p.stdout) : undefined,
    ])
    const code = await p.exited
    // A grandchild of `sh -c` that outlives it keeps the pipe open; what it
    // said by then is enough.
    await Promise.race([reading, Bun.sleep(200)])
    return { code, err: Buffer.concat(chunks).toString() }
  }
  const why = reasons()

  return {
    // Each run asks for one (`vx watch` runs again): a new run, on the tree as it is now.
    async relay() {
      closed = false
      relay = await loopbackRelay()
      return relay.url
    },

    async spawn(a) {
      const work = (async () => {
        base ??= (async () => {
          const d = await mkdtemp(path.join(os.tmpdir(), BASE_PREFIX))
          // Whose they are, for a later run to reclaim once this vx is gone.
          await writeFile(path.join(d, OWNER), String(process.pid))
          void reclaim(a.workspaceRoot)
          return d
        })()
        roots.add(a.workspaceRoot)
        const dir = path.join(await base, String(a.index))
        if (closed) return
        // The run's own snapshot: one taken here, after a hit restored a
        // committed file, was another tree, and every worker was refused
        // (2026-10-25).
        const add = await run(
          ['git', 'worktree', 'add', '-q', '--detach', dir, a.commit],
          a.workspaceRoot,
          { ...process.env, GIT_INDEX_FILE: undefined },
        )
        if (add.code !== 0) throw new Error(`git worktree add: ${errorLine(add.err)}`)
        // The workspace's own place in the checkout: from the worktree's
        // root, a workspace in a subdirectory of its repository had no
        // `.vx/workspace` above, and every worker exited (2026-10-25).
        const prefix = Bun.spawn(['git', 'rev-parse', '--show-prefix'], {
          cwd: a.workspaceRoot,
          stdout: 'pipe',
          stderr: 'ignore',
        })
        const at = path.join(dir, (await new Response(prefix.stdout).text()).trim())
        const env: Record<string, string | undefined> = { ...process.env, ...a.env }
        // The worktree is a repository of its own: a hook's index or
        // repository would stand in for it.
        for (const name of GIT_REPO_ENV) delete env[name]
        // A cache dir the workspace names, relative, would name each
        // worktree's own store, where the run cannot read what it saved.
        if (a.cacheDir !== undefined) env['VX_CACHE_DIR'] = a.cacheDir
        if (options.prepare !== undefined && !closed) {
          const p = await run(['sh', '-c', options.prepare], at, env, true, true)
          if (p.code !== 0 && !closed)
            throw new Error(await why(`prepare exited ${p.code}`, a.id, p.err))
        }
        if (closed) return
        void run([...vx(), 'dte', 'worker'], at, env, false).then(async (r) => {
          if (!closed) a.exited(await why(`exited ${r.code}`, a.id, r.err))
        })
      })()
      pending.add(work)
      try {
        await work
      } finally {
        pending.delete(work)
      }
    },

    async close() {
      closed = true
      // The relay closing the run tells each worker to leave; a prepare
      // still running is stopped.
      relay?.stop()
      relay = undefined
      for (const p of helpers) group(p, 'SIGTERM')
      // A detached shell waits for what this run started, kills what is
      // left after 5 s, then removes the worktrees, after vx exits:
      // removing ones an install filled took seconds after a Ctrl-C
      // (2026-10-21), and a 300k-file tree 2.7 s. Spawned first: core stops
      // waiting on a teardown after 3 s, and a worker slow to leave kept
      // close from spawning it before vx exited, so every worktree stayed
      // (2026-11-08). `prune` then drops git's record of each.
      if (base !== undefined) {
        const dir = await base
        base = undefined
        const helping = [...helpers].map((p) => p.pid).join(' ')
        const working = [...procs]
          .filter((p) => !helpers.has(p))
          .map((p) => p.pid)
          .join(' ')
        Bun.spawn(['sh', '-c', CLEANUP, 'sh', dir, helping, working, ...roots], {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        }).unref()
      }
      roots.clear()
      // Bounded under core's deadline: what still runs after it is the shell's.
      await Promise.race([
        Promise.allSettled([...pending, ...[...procs].map((p) => p.exited)]),
        Bun.sleep(2_000),
      ])
    },
  }
}

/**
 * `sh -c CLEANUP sh <base> <helper pids> <worker pids> <roots…>`: waits up
 * to 5 s for the pids, kills each left (a helper's whole group), removes
 * the base and prunes each root's worktree records.
 */
const CLEANUP = `d=$1 h=$2 w=$3; shift 3
i=0
while [ $i -lt 50 ]; do
  up=; for p in $h $w; do kill -0 $p 2>/dev/null && up=1; done
  [ -z "$up" ] && break
  sleep 0.1; i=$((i+1))
done
for p in $h; do kill -9 -$p 2>/dev/null; done
for p in $w; do kill -9 $p 2>/dev/null; done
rm -rf "$d"; for r; do git -C "$r" worktree prune; done`

const BASE_PREFIX = 'vx-dte-'
const OWNER = 'owner'
/** `mkdtemp`'s name: the prefix and six characters. */
const OWN_BASE = new RegExp(`^${BASE_PREFIX}[A-Za-z0-9]{6}$`)

/**
 * The worktrees a run whose vx was killed (SIGKILL, a lost machine) left in
 * `root`'s repository, removed: each under a base whose owner process is
 * gone. A killed run's close never ran, and they stayed for good
 * (2026-11-06). One `git worktree list`, off the run's path. So are this
 * machine's other bases whose owner is gone: one of a repository no run
 * comes back to (a test's, deleted) stayed for good too (2026-11-11).
 */
async function reclaim(root: string): Promise<void> {
  try {
    const env: Record<string, string | undefined> = { ...process.env }
    for (const name of GIT_REPO_ENV) delete env[name]
    const list = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const bases = new Set<string>()
    const tmp = os.tmpdir()
    for (const name of await readdir(tmp).catch(() => []))
      if (OWN_BASE.test(name)) bases.add(path.join(tmp, name))
    for (const line of (await new Response(list.stdout).text()).split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const dir = line.slice('worktree '.length)
      const base = path.dirname(dir)
      if (/^\d+$/.test(path.basename(dir)) && OWN_BASE.test(path.basename(base))) bases.add(base)
    }
    const gone: string[] = []
    for (const base of bases) {
      const pid = Number(
        await readFile(path.join(base, OWNER), 'utf8').catch(
          // quiet: a base with no owner is not known to be gone
          () => '',
        ),
      )
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) gone.push(base)
    }
    if (gone.length === 0) return
    Bun.spawn(
      ['sh', '-c', 'r=$1; shift; rm -rf "$@"; git -C "$r" worktree prune', 'sh', root, ...gone],
      {
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      },
    ).unref()
  } catch {
    // quiet: what is left is reclaimed by the next run
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // Another user's process is alive too.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Signal `p`'s process group: a helper leads its own (`detached`). */
function group(p: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-p.pid, signal)
  } catch {
    // quiet: the group is gone
  }
}

/**
 * `<what>: <its error line> (log: <path>)`, a worker's whole stderr kept at
 * that path, which outlives the run.
 */
export function reasons(): (what: string, id: string, err: string) => Promise<string> {
  let logs: Promise<string> | undefined
  return async (what, id, err) => {
    const line = errorLine(err)
    if (line === '') return what
    logs ??= mkdtemp(path.join(os.tmpdir(), 'vx-dte-logs-'))
    const file = path.join(await logs, `${id}.log`)
    await writeFile(file, err)
    return `${what}: ${line} (log: ${file})`
  }
}

/**
 * The line of a process's stderr that says what went wrong: vx's own `✗`
 * line, else the first naming an error or git's `fatal:`, else the last. The last alone was
 * often a hint (`fix  vx run …`) that hid the error above it.
 */
export function errorLine(text: string): string {
  const lines = Bun.stripANSI(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (
    lines.find((l) => l.startsWith('✗')) ??
    lines.find((l) => /\berror\b|^fatal:/i.test(l)) ??
    lines.at(-1) ??
    ''
  )
}

/** A relay of the run's own on loopback, with no auth: only this machine reaches it. */
export async function loopbackRelay(): Promise<{ url: string; stop(): void }> {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const server = serveRelay({ hostname: '127.0.0.1', port: 0 })
  return {
    url: server.url,
    stop() {
      void server.stop()
    },
  }
}

/**
 * What `git rev-parse --local-env-vars` names: variables that tie a
 * process to one repository and its index. A git hook sets
 * `GIT_INDEX_FILE` (and, in a linked worktree, `GIT_DIR`); a worktree add
 * under them wrote its checkout to the hook's index, or failed on a
 * relative one, and a worker read the hook's repository.
 */
const GIT_REPO_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]

/** The argv that runs this vx: the binary when compiled, else Bun and its entry. */
function vx(): string[] {
  const compiled = Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/')
  return compiled ? [process.execPath] : [process.execPath, Bun.main]
}
