// `local()`: agents as processes on this machine, each in its own git
// worktree of `HEAD`, and a relay of its own on loopback. For tests, demos
// and trying a distributed run before a CI starts the agents.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { refuseUnknownOptions, type PluginOptionKinds } from '@vzn/vx'
import type { DteAdapter } from './plugin.js'

export interface LocalOptions {
  /** A shell line each worktree runs before its agent starts, such as `bun install`. */
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

  // Async throughout: a run starts its agents while it shows its first rows.
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
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    return { code, err: lastLine(err) }
  }

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
        const add = await run(
          ['git', 'worktree', 'add', '-q', '--detach', dir, 'HEAD'],
          a.workspaceRoot,
        )
        if (add.code !== 0) throw new Error(`git worktree add: ${add.err}`)
        trees.push({ root: a.workspaceRoot, dir })
        const env = { ...process.env, ...a.env }
        if (options.prepare !== undefined && !closed) {
          const p = await run(['sh', '-c', options.prepare], dir, env)
          if (p.code !== 0 && !closed)
            throw new Error(`prepare exited ${p.code}${p.err === '' ? '' : `: ${p.err}`}`)
        }
        if (closed) return
        void run([...vx(), 'dte', 'agent'], dir, env, false).then((r) => {
          if (r.code !== 0 && !closed)
            a.exited(`exited ${r.code}${r.err === '' ? '' : `: ${r.err}`}`)
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
      // The relay closing the run tells each agent to leave; a prepare
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
      for (const t of trees.splice(0)) {
        Bun.spawnSync(['git', 'worktree', 'remove', '--force', t.dir], { cwd: t.root })
      }
      if (base !== undefined) await rm(await base, { recursive: true, force: true })
      base = undefined
    },
  }
}

/** The last non-empty line of a process's stderr: what it said as it ended. */
export function lastLine(text: string): string {
  return text.trimEnd().split('\n').at(-1)?.trim() ?? ''
}

/** A relay of the run's own on loopback, with no auth: only this machine reaches it. */
export async function loopbackRelay(): Promise<{ url: string; stop(): void }> {
  const { createRelay } = await import('@vzn/vx-dte-relay')
  const r = createRelay()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => r.fetch(req),
    idleTimeout: 60,
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      r.close()
      void server.stop(true)
    },
  }
}

/** The argv that runs this vx: the binary when compiled, else Bun and its entry. */
function vx(): string[] {
  const compiled = Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/')
  return compiled ? [process.execPath] : [process.execPath, Bun.main]
}
