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
  let tree: Promise<{ commit: string }> | undefined
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
  ) => {
    const p = start(
      Bun.spawn(argv, {
        cwd,
        env: env ?? process.env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    )
    if (helper) {
      helpers.add(p)
      void p.exited.then(() => helpers.delete(p))
    }
    const chunks: Uint8Array[] = []
    const reading = (async () => {
      for await (const c of p.stderr) chunks.push(c)
    })()
    const code = await p.exited
    // A grandchild of `sh -c` that outlives it keeps the pipe open; what it
    // said by then is enough.
    await Promise.race([reading, Bun.sleep(200)])
    return { code, err: Buffer.concat(chunks).toString() }
  }
  const why = reasons()

  return {
    async relay() {
      relay = await loopbackRelay()
      return relay.url
    },

    async spawn(a) {
      const work = (async () => {
        base ??= mkdtemp(path.join(os.tmpdir(), 'vx-dte-'))
        const dir = path.join(await base, String(a.index))
        if (closed) return
        tree ??= import('./tree.js').then((m) => m.snapshot(a.workspaceRoot))
        const add = await run(
          ['git', 'worktree', 'add', '-q', '--detach', dir, (await tree).commit],
          a.workspaceRoot,
        )
        if (add.code !== 0) throw new Error(`git worktree add: ${errorLine(add.err)}`)
        trees.push({ root: a.workspaceRoot, dir })
        const env: Record<string, string | undefined> = { ...process.env, ...a.env }
        // A relative cache dir would name each worktree's own store, where
        // the run cannot read what the worker saved.
        const cacheDir = env['VX_CACHE_DIR']
        if (
          cacheDir !== undefined &&
          cacheDir !== '' &&
          !path.isAbsolute(cacheDir) &&
          !cacheDir.startsWith('~')
        ) {
          env['VX_CACHE_DIR'] = path.resolve(a.workspaceRoot, cacheDir)
        }
        if (options.prepare !== undefined && !closed) {
          const p = await run(['sh', '-c', options.prepare], dir, env)
          if (p.code !== 0 && !closed)
            throw new Error(await why(`prepare exited ${p.code}`, a.id, p.err))
        }
        if (closed) return
        void run([...vx(), 'dte', 'worker'], dir, env, false).then(async (r) => {
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
      for (const p of helpers) p.kill('SIGTERM')
      const grace = setTimeout(() => {
        for (const p of procs) p.kill('SIGKILL')
      }, 5_000)
      await Promise.allSettled([...pending])
      await Promise.all([...procs].map((p) => p.exited))
      clearTimeout(grace)
      // A detached shell removes the worktrees after vx exits: removing ones
      // an install filled took seconds after a Ctrl-C (M, 2026-10-21), and a
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
  const { serveRelay } = await import('@vzn/vx-dte-relay')
  const server = serveRelay({ hostname: '127.0.0.1', port: 0 })
  return {
    url: server.url,
    stop() {
      void server.stop()
    },
  }
}

/** The argv that runs this vx: the binary when compiled, else Bun and its entry. */
function vx(): string[] {
  const compiled = Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/')
  return compiled ? [process.execPath] : [process.execPath, Bun.main]
}
