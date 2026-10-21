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
  let base: string | undefined
  const agents = new Set<ReturnType<typeof Bun.spawn>>()
  const trees: Array<{ root: string; dir: string }> = []

  return {
    async relay() {
      const { createRelay } = await import('@vzn/vx-dte-relay')
      const r = createRelay()
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (req) => r.fetch(req),
        idleTimeout: 60,
      })
      relay = {
        url: `http://127.0.0.1:${server.port}`,
        stop() {
          r.close()
          void server.stop(true)
        },
      }
      return relay.url
    },

    async spawn(a) {
      base ??= await mkdtemp(path.join(os.tmpdir(), 'vx-dte-'))
      const dir = path.join(base, String(a.index))
      const add = Bun.spawnSync(['git', 'worktree', 'add', '-q', '--detach', dir, 'HEAD'], {
        cwd: a.workspaceRoot,
        stderr: 'pipe',
      })
      if (add.exitCode !== 0) throw new Error(`git worktree add: ${add.stderr.toString().trim()}`)
      trees.push({ root: a.workspaceRoot, dir })
      const env = { ...process.env, ...a.env }
      if (options.prepare !== undefined) {
        const p = Bun.spawn(['sh', '-c', options.prepare], {
          cwd: dir,
          env,
          stdout: 'ignore',
          stderr: 'ignore',
        })
        if ((await p.exited) !== 0) throw new Error(`prepare exited ${p.exitCode}`)
      }
      const proc = Bun.spawn([...vx(), 'dte', 'agent'], {
        cwd: dir,
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      agents.add(proc)
      void proc.exited.then(() => agents.delete(proc))
    },

    async close() {
      // The relay closing the run tells each agent to leave.
      relay?.stop()
      relay = undefined
      const left = [...agents]
      const grace = setTimeout(() => {
        for (const p of left) p.kill('SIGKILL')
      }, 5_000)
      await Promise.all(left.map((p) => p.exited))
      clearTimeout(grace)
      for (const t of trees.splice(0)) {
        Bun.spawnSync(['git', 'worktree', 'remove', '--force', t.dir], { cwd: t.root })
      }
      if (base !== undefined) await rm(base, { recursive: true, force: true })
      base = undefined
    },
  }
}

/** The argv that runs this vx: the binary when compiled, else Bun and its entry. */
function vx(): string[] {
  const compiled = Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/')
  return compiled ? [process.execPath] : [process.execPath, Bun.main]
}
