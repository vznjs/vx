// `vx dte agent`: one CI job's share of a run. It joins the run's relay,
// runs what the orchestrator sends in its own checkout, and sends back each
// task's streams and the files its outputs left.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fromParts, outputFiles, pack, toParts, unpack } from './bundle.js'
import type { AgentInfo, ToAgent } from './messages.js'
import { runCommand } from './run-command.js'
import { join, RelayError } from './wire.js'

/** Names whose value is this machine's, never the orchestrator's. */
const HOST_ENV = [
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'npm_execpath',
  'PNPM_HOME',
  'COREPACK_HOME',
]

export async function runAgent(opts: {
  relay: string
  run: string
  size: string
  slots: number
  root: string
  token: string | undefined
  log: (line: string) => void
}): Promise<number> {
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: opts.root })
    .stdout.toString()
    .trim()
  const info: AgentInfo = { v: 1, size: opts.size, slots: opts.slots, commit }
  const me = await join(opts.relay, opts.run, 'agent', info, opts.token)
  opts.log(`vx dte agent ${opts.size} joined run ${opts.run}`)
  const parts = new Map<string, string[]>()
  const running = new Map<string, AbortController>()
  const work = new Set<Promise<void>>()

  const runTask = async (m: Extract<ToAgent, { type: 'run' }>): Promise<void> => {
    const stop = new AbortController()
    running.set(m.task, stop)
    try {
      const upstream = parts.get(m.task) ?? []
      parts.delete(m.task)
      if (upstream.length > 0) await unpack(opts.root, fromParts(upstream))
      // An earlier task's files under these outputs would ship as this one's.
      for (const f of await outputFiles(opts.root, m.project, m.outputs)) {
        await rm(path.join(opts.root, f), { force: true })
      }
      const res = await runCommand({
        command: m.command,
        cwd: path.join(opts.root, m.cwd),
        env: localEnv(m.env, m.root, opts.root),
        timeoutMs: m.timeoutMs,
        signal: stop.signal,
      })
      const files = await outputFiles(opts.root, m.project, m.outputs)
      const out = toParts(await pack(opts.root, files, res))
      for (const data of out) await me.send('orchestrator', { type: 'part', task: m.task, data })
      await me.send('orchestrator', { type: 'end', task: m.task, parts: out.length })
    } finally {
      running.delete(m.task)
    }
  }

  try {
    for (;;) {
      let messages
      try {
        messages = await me.poll()
      } catch (err) {
        if (err instanceof RelayError && err.status === 410) return 0
        throw err
      }
      for (const { from, body } of messages) {
        if (from === 'relay') {
          if ((body as { type?: string }).type === 'closed') return 0
          continue
        }
        const m = body as ToAgent
        if (m.type === 'refused') {
          opts.log(`vx dte agent: refused: ${m.reason}`)
          return 1
        }
        if (m.type === 'part') {
          const list = parts.get(m.task) ?? []
          list.push(m.data)
          parts.set(m.task, list)
        } else if (m.type === 'cancel') {
          running.get(m.task)?.abort()
        } else if (m.type === 'run') {
          const p = runTask(m).catch((err: unknown) =>
            opts.log(`vx dte agent: ${m.task}: ${String(err)}`),
          )
          work.add(p)
          void p.finally(() => work.delete(p))
        }
      }
    }
  } finally {
    for (const c of running.values()) c.abort()
    await Promise.all(work)
    await me.leave()
  }
}

/**
 * The orchestrator's env for a task, made this machine's: its checkout root
 * swapped for ours, host names from our own env, and PATH our own behind
 * the workspace's bin directories.
 */
export function localEnv(
  env: Readonly<Record<string, string>>,
  remoteRoot: string,
  root: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) out[k] = v.replaceAll(remoteRoot, root)
  for (const k of HOST_ENV) out[k] = process.env[k]
  const bins = (out['PATH'] ?? '').split(':').filter((p) => p.startsWith(root))
  out['PATH'] = [...bins, process.env['PATH'] ?? ''].join(':')
  return out
}
