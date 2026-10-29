// `local()`: workers as processes on this machine, each in its own git
// worktree of the working tree's tracked state, and a relay of its own on
// loopback. For tests, demos
// and trying a distributed run before a CI starts the workers.

import { mkdtemp, writeFile } from 'node:fs/promises'
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
  const trees: Array<{ root: string; dir: string }> = []
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
        base ??= mkdtemp(path.join(os.tmpdir(), 'vx-dte-'))
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
        trees.push({ root: a.workspaceRoot, dir })
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
      const grace = setTimeout(() => {
        for (const p of procs) {
          if (helpers.has(p)) group(p, 'SIGKILL')
          else p.kill('SIGKILL')
        }
      }, 5_000)
      await Promise.allSettled([...pending])
      await Promise.all([...procs].map((p) => p.exited))
      clearTimeout(grace)
      // A detached shell removes the worktrees after vx exits: removing ones
      // an install filled took seconds after a Ctrl-C (2026-10-21), and a
      // 300k-file tree 2.7 s. `prune` then drops git's record of each.
      const roots = [...new Set(trees.splice(0).map((t) => t.root))]
      if (base !== undefined) {
        const dir = await base
        base = undefined
        Bun.spawn(
          [
            'sh',
            '-c',
            'rm -rf "$1"; shift; for r; do git -C "$r" worktree prune; done',
            'sh',
            dir,
            ...roots,
          ],
          { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
        ).unref()
      }
    },
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
