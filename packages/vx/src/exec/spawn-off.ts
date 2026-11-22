// A task's spawn on a thread of its own. Bun's spawn holds the calling thread
// until the child has exec'd (vfork), ~0.6 ms a task, and on a cold run that
// thread is the scheduler's: 2,000 tasks with 1.8 ms of the scheduler's own
// work each took 4.96 s spawned there and 3.71 s spawned here, the 3.6 s of
// that work the floor. The child's descriptors are numbers in the one table
// every thread shares, so its pipes are made and read where they were; only the
// spawn and the wait for its exit move.
//
// On Linux the thread hands a task's shell to `vx-measure` instead
// (measure/vx-measure.c): one small process per vx, started at the first
// task, that forks every shell, so the shell's peak memory is its own and
// not vx's, which a vforked child inherits at exec. The descriptors cross
// to it over a socket (SCM_RIGHTS); it says each pid, then each exit and its
// usage. Where it cannot start, declines a spawn or dies, the thread spawns
// as before. docs/design/peak-memory-exact-2026-11.md.

import type { ResourceUsage } from 'bun'

import { beforeExit } from '../util/index.js'

/** What `runCommand` reads of a child spawned here. */
export interface OffChild {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  resourceUsage(): ResourceUsage | undefined
  /** Once exited, when `vx-measure` forked it: its own peak in bytes (the wait of a clean fork). */
  measuredPeak(): number | undefined
  kill(signal?: NodeJS.Signals | number): void
  /** Hold the process open from now until the child exits: a spawn with `held: false` does not. */
  hold(): void
}

export interface OffSpawn {
  cmd: string[]
  argv0?: string
  cwd?: string
  env?: Record<string, string>
  /** Each a descriptor number or `'ignore'`: a stream cannot cross threads. */
  stdio: Array<number | 'ignore'>
  detached?: boolean
  /** False: once spawned, the child keeps no run alive until `hold()` (a spare shell waiting for its task). */
  held?: boolean
  /** Linux: the `vx-measure` helper's path, to fork the command there; `cmd[0]` an absolute path. */
  measure?: string | undefined
}

// The worker as source, not a file: a compiled vx carries only its entry
// point's graph, and a worker file would need an entry point of its own.
const WORKER = `
import { closeSync } from 'node:fs'
import { constants } from 'node:os'
const live = new Map()
// A shell vx-measure forked: id -> its pid, until its exit is told.
const forked = new Map()
// Asked of vx-measure, not yet answered: id -> the request.
const asked = new Map()
// Each number's first name (SIGABRT, not SIGIOT); one with none is told by number, as Bun does.
const SIGNAL_NAME = {}
for (const [k, v] of Object.entries(constants.signals)) SIGNAL_NAME[v] ??= k
const RECORD = 40
const SPAWN = 1, KILL = 2
const HELLO = 0, SPAWNED = 1, EXITED = 2, DECLINED = 3
// One request: past this the socket refuses it, and the thread spawns it itself.
const MAX_REQUEST = 200 * 1024
let z
let libc

function calls() {
  if (libc !== undefined) return libc
  libc = null
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi')
    const { symbols } = dlopen('libc.so.6', {
      socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
      setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    })
    libc = { ...symbols, ptr }
  } catch {}
  return libc
}

// The helper, started once; undefined where it cannot run or has died.
function zygote(path) {
  if (z !== undefined) return z.dead ? undefined : z
  z = { dead: true, up: false }
  const c = calls()
  if (c === null) return undefined
  const sv = new Int32Array(2)
  const pw = new Int32Array(2)
  // AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC; a pipe, O_CLOEXEC.
  if (c.socketpair(1, 5 | 0o2000000, 0, c.ptr(sv)) !== 0) return undefined
  if (c.pipe2(c.ptr(pw), 0o2000000) !== 0) {
    closeSync(sv[0]); closeSync(sv[1])
    return undefined
  }
  let proc
  try {
    // Its own session: no group signal of the terminal or of vx reaches it.
    // No environment: each request carries its task's, and vx's own stays out of /proc.
    proc = Bun.spawn([path], { stdio: ['ignore', 'ignore', 'ignore', sv[1], pw[1]], detached: true, env: {} })
  } catch {
    for (const fd of [sv[0], sv[1], pw[0], pw[1]]) closeSync(fd)
    return undefined
  }
  closeSync(sv[1]); closeSync(pw[1])
  proc.unref()
  // A burst of spawns waits for the helper rather than spawning here: room
  // for many environments (SO_SNDBUF, capped by wmem_max), and a send that
  // waits longer than a second (SO_SNDTIMEO) is a refusal.
  c.setsockopt(sv[0], 1, 7, c.ptr(new Int32Array([4 << 20])), 4)
  c.setsockopt(sv[0], 1, 21, c.ptr(new BigInt64Array([1n, 0n])), 16)
  z = { dead: false, up: false, sock: sv[0], proc }
  // Its death is the pipe's end, once every record it wrote is read.
  void read(pw[0])
  return z
}

async function read(fd) {
  const r = Bun.file(fd).stream().getReader()
  let rest = new Uint8Array(0)
  try {
    for (;;) {
      const { value, done } = await r.read()
      if (done) break
      const buf = rest.length === 0 ? value : concat(rest, value)
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      let at = 0
      for (; at + RECORD <= buf.length; at += RECORD) told(view, at)
      rest = buf.slice(at)
    }
  } catch {}
  ended()
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function told(v, at) {
  const kind = v.getUint32(at, true)
  const id = v.getUint32(at + 4, true)
  if (kind === HELLO) { z.up = true; return }
  if (kind === SPAWNED) {
    asked.delete(id)
    const pid = v.getInt32(at + 8, true)
    forked.set(id, pid)
    postMessage({ id, pid })
    return
  }
  if (kind === DECLINED) {
    const m = asked.get(id)
    asked.delete(id)
    if (m !== undefined) spawn(m)
    return
  }
  if (kind !== EXITED || !forked.has(id)) return
  forked.delete(id)
  const status = v.getInt32(at + 12, true)
  const kib = Number(v.getBigUint64(at + 16, true))
  const user = Number(v.getBigUint64(at + 24, true))
  const system = Number(v.getBigUint64(at + 32, true))
  const sig = status & 0x7f
  postMessage({
    id,
    exitCode: sig === 0 ? (status >> 8) & 0xff : null,
    signalCode: sig === 0 ? null : (SIGNAL_NAME[sig] ?? sig),
    usage: { cpuTime: { user, system, total: user + system }, maxRSS: kib * 1024 },
    peak: kib * 1024,
  })
}

// The helper is gone: what it was asked before it said hello is spawned
// here; a shell it forked can no longer be waited for, so its group is
// killed and the task ends with that signal.
function ended() {
  if (z === undefined || z.dead) return
  z.dead = true
  if (z.sock >= 0) closeSync(z.sock)
  z.sock = -1
  for (const [id, m] of asked) {
    asked.delete(id)
    if (!z.up) spawn(m)
    else postMessage({ id, error: { message: 'vx-measure ended before the task started' } })
  }
  for (const [id, pid] of forked) {
    forked.delete(id)
    try { process.kill(-pid, 'SIGKILL') } catch {}
    postMessage({ id, exitCode: null, signalCode: 'SIGKILL' })
  }
}

const enc = new TextEncoder()

function send(zz, header, body, fds) {
  const c = libc
  const msg = new Uint8Array(24 + body.length)
  new Uint32Array(msg.buffer, 0, 6).set(header)
  msg.set(body, 24)
  const iov = new BigUint64Array([BigInt(c.ptr(msg)), BigInt(msg.length)])
  const hdr = new BigUint64Array(7)
  hdr[2] = BigInt(c.ptr(iov))
  hdr[3] = 1n
  let control
  if (fds.length > 0) {
    // cmsghdr {len, SOL_SOCKET, SCM_RIGHTS} and the descriptors, padded to 8.
    control = new ArrayBuffer(16 + Math.ceil((fds.length * 4) / 8) * 8)
    const v = new DataView(control)
    v.setBigUint64(0, BigInt(16 + fds.length * 4), true)
    v.setInt32(8, 1, true)
    v.setInt32(12, 1, true)
    fds.forEach((fd, i) => v.setInt32(16 + i * 4, fd, true))
    hdr[4] = BigInt(c.ptr(new Uint8Array(control)))
    hdr[5] = BigInt(control.byteLength)
  }
  // MSG_NOSIGNAL: a closed socket is a refusal, not a SIGPIPE.
  return Number(c.sendmsg(zz.sock, c.ptr(hdr), 0x4000)) === msg.length
}

// Ask vx-measure to fork it; false: spawn it here.
function viaZygote(m) {
  const o = m.opts
  const file = o.cmd[0]
  if (typeof file !== 'string' || !file.startsWith('/')) return false
  const zz = zygote(o.measure)
  if (zz === undefined) return false
  const env = o.env ?? process.env
  const strings = [file, o.cwd ?? '', o.argv0 ?? file, ...o.cmd.slice(1)]
  const argc = o.cmd.length
  let envc = 0
  for (const k in env) {
    const val = env[k]
    if (val === undefined) continue
    strings.push(k + '=' + val)
    envc++
  }
  const text = strings.join('\\0') + '\\0'
  if (text.length > MAX_REQUEST || o.stdio.length > 16 || hasNul(strings)) return false
  const body = enc.encode(text)
  if (body.length > MAX_REQUEST) return false
  let ignored = 0
  const fds = []
  o.stdio.forEach((s, i) => (s === 'ignore' ? (ignored |= 1 << i) : fds.push(s)))
  if (!send(zz, [SPAWN, m.id, o.stdio.length, ignored, argc, envc], body, fds)) return false
  asked.set(m.id, m)
  return true
}

function hasNul(strings) {
  for (const s of strings) if (s.includes('\\0')) return true
  return false
}

function spawn(m) {
  let p
  try {
    p = Bun.spawn(m.opts.cmd, m.opts)
  } catch (err) {
    postMessage({ id: m.id, error: { message: String(err?.message ?? err), code: err?.code } })
    return
  }
  live.set(m.id, p)
  postMessage({ id: m.id, pid: p.pid })
  p.exited.then(() => {
    live.delete(m.id)
    const u = p.resourceUsage()
    // Its two fields vx reads: the object itself does not cross threads.
    const usage = u === undefined ? undefined : { cpuTime: { user: u.cpuTime.user, system: u.cpuTime.system, total: u.cpuTime.total }, maxRSS: u.maxRSS }
    postMessage({ id: m.id, exitCode: p.exitCode, signalCode: p.signalCode, usage })
  })
}

self.onmessage = (e) => {
  const m = e.data
  if (m.close) {
    // The verb is done: the socket's end ends the helper, and its exit, once
    // reaped here, brings the CPU of every shell it waited for into vx's own
    // children's usage. Left to die after vx, it went to init uncounted.
    if (z?.sock >= 0) {
      closeSync(z.sock)
      z.sock = -1
    }
    if (z?.proc === undefined) postMessage({ closed: true })
    else z.proc.exited.then(() => postMessage({ closed: true }))
    return
  }
  if (m.kill !== undefined) {
    const pid = forked.get(m.kill)
    if (pid === undefined) { live.get(m.kill)?.kill(m.signal); return }
    const sig = typeof m.signal === 'number' ? m.signal : constants.signals[m.signal ?? 'SIGTERM']
    // The helper kills only a child it has not reaped: its pid is not yet reused.
    if (sig !== undefined && (z.dead || !send(z, [KILL, m.kill, sig, pid, 0, 0], new Uint8Array(0), [])))
      try { process.kill(pid, sig) } catch {}
    return
  }
  if (m.opts.measure !== undefined && viaZygote(m)) return
  spawn(m)
}
`

interface Pending {
  held: () => boolean
  spawned: (pid: number) => void
  failed: (err: Error) => void
  exit: (m: {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    usage?: ResourceUsage
    peak?: number
  }) => void
}

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, Pending>()
let liveCount = 0
let closed: (() => void) | undefined
let closing = false

/**
 * Before vx exits, once a shell went through `vx-measure`: end the helper and
 * wait (at most 1 s) for its reap, so a run's usage counts its tasks' CPU.
 */
function closeHelper(): Promise<void> {
  const w = worker
  if (w === undefined) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000)
    closed = () => {
      clearTimeout(timer)
      resolve()
    }
    w.ref()
    w.postMessage({ close: true })
  }).finally(() => worker?.unref())
}

function thread(): Worker {
  if (worker !== undefined) return worker
  const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
  w.onmessage = (e: MessageEvent) => {
    const m = e.data
    if (m.closed === true) return closed?.()
    const p = pending.get(m.id)
    if (p === undefined) return
    if (m.error !== undefined) {
      pending.delete(m.id)
      const err = new Error(m.error.message) as NodeJS.ErrnoException
      if (m.error.code !== undefined) err.code = m.error.code
      settleLive(-1)
      p.failed(err)
    } else if (m.pid !== undefined) {
      if (!p.held()) settleLive(-1)
      p.spawned(m.pid)
    } else {
      pending.delete(m.id)
      if (p.held()) settleLive(-1)
      p.exit(m)
    }
  }
  // An idle thread keeps no run alive.
  w.unref()
  worker = w
  return w
}

/** Hold the process open while a child spawned here runs, as a spawn on the main thread does. */
function settleLive(delta: number): void {
  liveCount += delta
  if (liveCount > 0) worker?.ref()
  else worker?.unref()
}

/** Spawn `opts` on the spawn thread; resolves once the child is running, rejects when the spawn threw. */
export function spawnOff(opts: OffSpawn): Promise<OffChild> {
  const w = thread()
  if (opts.measure !== undefined && !closing) {
    closing = true
    beforeExit(closeHelper)
  }
  const id = nextId++
  let held = opts.held !== false
  // Every spawn holds the run until its reply: a caller awaiting a spare's
  // spawn (`runOnSpare`) had nothing else holding the loop, and the run drained
  // mid-graph with every slot waiting on one.
  settleLive(1)
  const { held: _, ...spawn } = opts
  return new Promise((resolve, reject) => {
    let exitCode: number | null = null
    let signalCode: NodeJS.Signals | null = null
    let usage: ResourceUsage | undefined
    let peak: number | undefined
    let onExit!: (code: number) => void
    const exited = new Promise<number>((r) => (onExit = r))
    pending.set(id, {
      held: () => held,
      failed: reject,
      spawned: (pid) =>
        resolve({
          pid,
          exited,
          get exitCode() {
            return exitCode
          },
          get signalCode() {
            return signalCode
          },
          resourceUsage: () => usage,
          measuredPeak: () => peak,
          kill: (signal) => w.postMessage({ kill: id, signal }),
          hold: () => {
            if (held || exitCode !== null || signalCode !== null) return
            held = true
            settleLive(1)
          },
        }),
      exit: (m) => {
        exitCode = m.exitCode
        signalCode = m.signalCode
        usage = m.usage
        peak = m.peak
        onExit(exitCode ?? 1)
      },
    })
    w.postMessage({ id, opts: spawn })
  })
}
