// The run in progress, for `vx last --live` (2026-10-28): an agent that
// started `vx run` in the background asks what runs, what already failed
// and what it was warned of while the run goes on; the history holds a
// run only once it ended.
//
// The run answers on a unix socket beside its run lock (run-lock.ts),
// `<lock>.sock`: in this user's own lock directory, so no other user
// reaches it, and taken only while the lock is held, so a socket a killed
// run left is this run's to replace. Nothing is written for it: the run
// keeps which task started when (one Map entry per task) and builds the
// snapshot only when asked. Output is not kept; a reader that wants it
// follows (`--follow`), and a follower is fed only while it is attached
// and keeps up: one that falls a megabyte behind is let go, so a stuck
// reader never holds the run's memory or its event loop.
//
// The path is left with the lock, before the run's last steps, and a
// follower stays attached through `run:done`.
//
// The protocol is one request line, `snapshot` or `follow`, then the
// snapshot as one JSON line; a follower then gets each `WireEvent` as a
// line until `run:done`, and the run closes the connection.

import { unlinkSync } from 'node:fs'
import type { Socket, UnixSocketListener } from 'bun'
import { isGroupTask, type TaskNode } from '../graph/index.js'
import {
  type EventBus,
  type OutcomeView,
  projectOutcome,
  toWireEvent,
  type WireEvent,
} from '../report/index.js'
import { runLockPath } from './run-lock.js'

/** One task as a live reader sees it. */
export interface LiveTask {
  taskId: string
  /** `waiting`, `running`, or the status it ended with. */
  status: 'waiting' | 'running' | OutcomeView['status']
  /** Epoch ms it started; null while it waits (and for a skip, which never starts). */
  startedAt: number | null
  /** Null until it ends. */
  durationMs: number | null
}

/** What `vx last --live --format json` prints, the snapshot line. */
export interface LiveSnapshot {
  live: { runId: string; command: string; pid: number; startedAt: number; elapsedMs: number }
  tasks: LiveTask[]
  warnings: string[]
}

/** Where the run of `workspaceRoot` answers: beside its run lock. */
export function liveSocketPath(workspaceRoot: string, lockDir?: string): string {
  return `${runLockPath(workspaceRoot, lockDir)}.sock`
}

/** A follower this far behind is let go. */
const FOLLOW_BACKLOG = 1 << 20

interface Peer {
  follow: boolean
  /** Bytes the socket did not take yet. */
  pending: Uint8Array[]
  pendingBytes: number
  /** End the connection once `pending` drains. */
  ending: boolean
  request: string
}

const encoder = new TextEncoder()

/**
 * Serve the run's live state on `socketPath` until the returned close.
 * Never fails the run: a socket that cannot be made (a path too long, a
 * second run in this process holding it) leaves the run unanswered.
 */
export function serveLive(opts: {
  socketPath: string
  bus: EventBus
  runId: string
  command: string
  startedAt: number
  nodes: () => Iterable<TaskNode>
  warnings: () => readonly string[]
}): { unlisten(): void; dispose(): void } {
  const started = new Map<string, number>()
  const ended = new Map<
    string,
    OutcomeView['status'] | { status: OutcomeView['status']; durationMs: number }
  >()
  const peers = new Map<Socket<Peer>, Peer>()
  let followers = 0

  const flush = (sock: Socket<Peer>, peer: Peer): void => {
    while (peer.pending.length > 0) {
      const head = peer.pending[0]!
      const n = sock.write(head)
      if (n < 0) return
      peer.pendingBytes -= n
      if (n < head.length) {
        peer.pending[0] = head.subarray(n)
        return
      }
      peer.pending.shift()
    }
    if (peer.ending) sock.end()
  }
  const send = (sock: Socket<Peer>, peer: Peer, line: string): void => {
    const bytes = encoder.encode(`${line}\n`)
    peer.pending.push(bytes)
    peer.pendingBytes += bytes.length
    if (peer.follow && peer.pendingBytes > FOLLOW_BACKLOG) {
      drop(sock, peer)
      return
    }
    if (peer.pending.length === 1) flush(sock, peer)
  }
  const drop = (sock: Socket<Peer>, peer: Peer): void => {
    if (peers.delete(sock) && peer.follow) followers--
    sock.end()
  }

  const snapshot = (): LiveSnapshot => {
    const now = Date.now()
    const tasks: LiveTask[] = []
    for (const node of opts.nodes()) {
      if (isGroupTask(node)) continue
      const at = started.get(node.id) ?? null
      const end = ended.get(node.id)
      tasks.push(
        end !== undefined && typeof end === 'object'
          ? { taskId: node.id, status: end.status, startedAt: at, durationMs: end.durationMs }
          : at !== null
            ? { taskId: node.id, status: 'running', startedAt: at, durationMs: null }
            : { taskId: node.id, status: 'waiting', startedAt: null, durationMs: null },
      )
    }
    const rank = (t: LiveTask): number =>
      t.status === 'running' ? 0 : t.status === 'waiting' ? 2 : 1
    tasks.sort(
      (a, b) => rank(a) - rank(b) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    )
    return {
      live: {
        runId: opts.runId,
        command: opts.command,
        pid: process.pid,
        startedAt: opts.startedAt,
        elapsedMs: now - opts.startedAt,
      },
      tasks,
      warnings: opts.warnings().map((w) => Bun.stripANSI(w)),
    }
  }

  const unsubscribe = opts.bus.subscribe((event) => {
    if (event.kind === 'task:start') started.set(event.node.id, Date.now())
    else if (event.kind === 'task:complete') {
      ended.set(event.node.id, {
        status: event.outcome.status,
        durationMs: event.outcome.durationMs,
      })
    }
    if (followers === 0) return
    if (
      (event.kind === 'task:start' || event.kind === 'task:complete') &&
      isGroupTask(event.node)
    ) {
      return
    }
    const wire: WireEvent =
      event.kind === 'task:complete'
        ? { kind: 'task:complete', outcome: projectOutcome(event.outcome) }
        : toWireEvent(event)
    const line = JSON.stringify(wire)
    for (const [sock, peer] of peers) {
      if (!peer.follow) continue
      send(sock, peer, line)
      if (event.kind === 'run:done') peer.ending = true
      if (peer.ending && peer.pending.length === 0) drop(sock, peer)
    }
  })

  let listener: UnixSocketListener<Peer> | undefined
  try {
    unlinkSync(opts.socketPath)
  } catch {
    // None there: the usual case.
  }
  try {
    const made = Bun.listen<Peer>({
      unix: opts.socketPath,
      socket: {
        open(sock) {
          const peer: Peer = {
            follow: false,
            pending: [],
            pendingBytes: 0,
            ending: false,
            request: '',
          }
          sock.data = peer
          peers.set(sock, peer)
        },
        data(sock, chunk) {
          const peer = sock.data
          if (peer.request.includes('\n')) return
          peer.request += chunk.toString()
          if (!peer.request.includes('\n')) return
          const what = peer.request.trim()
          send(sock, peer, JSON.stringify(snapshot()))
          if (what === 'follow') {
            peer.follow = true
            followers++
          } else {
            peer.ending = true
            if (peer.pending.length === 0) drop(sock, peer)
          }
        },
        drain(sock) {
          flush(sock, sock.data)
        },
        close(sock) {
          const peer = peers.get(sock)
          if (peer !== undefined) drop(sock, peer)
        },
        error(sock) {
          const peer = peers.get(sock)
          if (peer !== undefined) drop(sock, peer)
        },
      },
    })
    // The socket must never keep a run's process alive past its end.
    made.unref()
    listener = made
  } catch {
    listener = undefined
  }

  return {
    // With the run lock: the next run may take the path the moment the lock
    // is free, so this run stops taking connections and leaves the path
    // first. Followers already attached stay, through `run:done`.
    unlisten: () => {
      if (listener === undefined) return
      listener.stop()
      listener = undefined
      try {
        unlinkSync(opts.socketPath)
      } catch {
        // Gone already.
      }
    },
    dispose: () => {
      unsubscribe()
      for (const [sock, peer] of [...peers]) {
        if (peer.pending.length > 0) peer.ending = true
        else drop(sock, peer)
      }
    },
  }
}
