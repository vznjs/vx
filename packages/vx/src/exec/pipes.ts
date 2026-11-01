// A task's stdout, stderr and held stdin as pipes vx makes itself (Linux),
// shared by the runner, the spare shells and the sandbox's spawn.

import type { Pointer } from 'bun:ffi'
import { closeSync } from 'node:fs'

const O_NONBLOCK = 0o4000
const O_CLOEXEC = 0o2000000
const F_SETFL = 4
const F_SETPIPE_SZ = 1031
/**
 * A pipe holds 64 KiB by default, and a 200 MB stdout drained 13% slower
 * through one than through Bun's socketpair (min of 7: 293 vs 259 ms);
 * at 256 KiB it drained in 230. Past the user's pipe quota the kernel
 * refuses the resize and the pipe keeps its 64 KiB.
 */
const PIPE_BYTES = 256 * 1024

type PipeCalls = {
  pipe2: (fds: Pointer, flags: number) => number
  fcntl: (fd: number, cmd: number, arg: number) => number
  ptr: (view: Int32Array, byteOffset?: number) => Pointer
}
let pipeCalls: PipeCalls | null | undefined

/** libc's `pipe2` and `fcntl`, bound once; null off Linux or where libc will not load. */
function linuxPipeCalls(): PipeCalls | null {
  if (pipeCalls !== undefined) return pipeCalls
  pipeCalls = null
  if (process.platform !== 'linux') return null
  try {
    // Loaded at the first spawn, not with the module: a static import cost
    // every vx start 0.3 ms, a warm run that spawns nothing included.
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    // glibc's soname; musl's loader answers any `libc.` name with itself
    // (ldso/dynlink.c's reserved names).
    const { symbols } = dlopen('libc.so.6', {
      pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    pipeCalls = { pipe2: symbols.pipe2, fcntl: symbols.fcntl, ptr }
  } catch {
    // Bun's socketpair, as before: only `/dev/stdout` by path fails on it.
  }
  return pipeCalls
}

/**
 * Two pipes, `[out read, out write, err read, err write]`, or undefined
 * when libc is not bound or a descriptor is not to be had (Bun's own
 * socketpair then fails the spawn with the reason).
 */
function realPipes(): Int32Array | undefined {
  const calls = linuxPipeCalls()
  if (calls === null) return undefined
  const fds = new Int32Array(4)
  // Bun's spawn closes every descriptor it is not handed (probed, Bun
  // 1.4.2); O_CLOEXEC keeps any other exec from holding a write end open.
  if (calls.pipe2(calls.ptr(fds), O_CLOEXEC) !== 0) return undefined
  if (calls.pipe2(calls.ptr(fds, 8), O_CLOEXEC) !== 0) {
    closeSync(fds[0]!)
    closeSync(fds[1]!)
    return undefined
  }
  // vx's ends only: a task whose stdout is non-blocking fails its writes with EAGAIN.
  calls.fcntl(fds[0]!, F_SETFL, O_NONBLOCK)
  calls.fcntl(fds[2]!, F_SETFL, O_NONBLOCK)
  calls.fcntl(fds[0]!, F_SETPIPE_SZ, PIPE_BYTES)
  calls.fcntl(fds[2]!, F_SETPIPE_SZ, PIPE_BYTES)
  return fds
}

/** One pipe, `[read, write]`, both close-on-exec, or undefined as {@link realPipes}. */
export function heldPipe(): Int32Array | undefined {
  const calls = linuxPipeCalls()
  if (calls === null) return undefined
  const fds = new Int32Array(2)
  return calls.pipe2(calls.ptr(fds), O_CLOEXEC) === 0 ? fds : undefined
}

/**
 * A task's stdout and stderr. Bun's `'pipe'` is a socketpair, and Linux
 * opens `/dev/stdout` through `/proc/self/fd/1`, which a socket refuses
 * (ENXIO): `echo x > /dev/stdout` and `cmd | tee /dev/stderr` failed in
 * every task, where a terminal or Turbo hands real pipes (X-113). So on
 * Linux vx makes the pipes (`pipe2` through `bun:ffi`) and hands the child
 * the write ends. macOS opens `/dev/fd/N` as a dup of the descriptor,
 * which a socket allows, so Bun's pipe stays there.
 *
 * `held`: stdin is a pipe vx keeps open and never writes (a persistent
 * task's, schema.md), for the same reason: `cat /dev/stdin` on Bun's
 * socketpair failed with ENXIO instead of blocking. Otherwise `'ignore'`.
 */
export class TaskPipes {
  /** Descriptor 0 for `Bun.spawn`'s `stdio`. */
  readonly stdin: number | 'pipe' | 'ignore'
  /** Descriptors 1 and 2 for `Bun.spawn`'s `stdio`. */
  readonly stdio: readonly [number | 'pipe', number | 'pipe']
  readonly #read: readonly number[]
  readonly #stdinWrite: number | undefined

  constructor(terminal?: boolean, held?: boolean) {
    const fds = terminal === true ? undefined : realPipes()
    this.stdio = fds === undefined ? ['pipe', 'pipe'] : [fds[1]!, fds[3]!]
    this.#read = fds === undefined ? [] : [fds[0]!, fds[2]!]
    const inFds = held === true && terminal !== true ? heldPipe() : undefined
    this.stdin = held !== true ? 'ignore' : inFds === undefined ? 'pipe' : inFds[0]!
    this.#stdinWrite = inFds?.[1]
  }

  /**
   * Close vx's copies of the child's ends once the spawn has returned or
   * thrown: the child holds its own, and a write end left here is a writer
   * the reader's EOF would wait for.
   */
  spawned(): void {
    for (const fd of [this.stdin, ...this.stdio]) if (typeof fd === 'number') closeSync(fd)
  }

  /** The child's stdout and stderr. */
  streams(
    child: ReturnType<typeof Bun.spawn>,
  ): [
    ReadableStream<Uint8Array> | number | undefined,
    ReadableStream<Uint8Array> | number | undefined,
  ] {
    const [out, err] = this.#read
    return out === undefined
      ? [child.stdout, child.stderr]
      : [Bun.file(out).stream(), Bun.file(err!).stream()]
  }

  /**
   * Close the read ends, once both streams have ended or been cancelled.
   * Bun reads a dup of each, but takes it on the stream's first pull: a
   * number closed before then was reused by the next spawn's pipe, and
   * the stream read THAT (probed, Bun 1.4.2).
   */
  close(): void {
    for (const fd of this.#read) closeSync(fd)
  }

  /**
   * Close the held stdin's write end, once the child has exited and its
   * output has ended. Not with the output alone: a server that sends it
   * to a log (`exec >log 2>&1`) ended its streams at once, read stdin EOF
   * and exited.
   */
  closeStdin(): void {
    if (this.#stdinWrite !== undefined) closeSync(this.#stdinWrite)
  }
}
