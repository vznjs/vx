// Did this process start with SIGHUP ignored? `nohup` and a supervisor
// that wants a job to outlive its terminal say so through the inherited
// disposition, and a `process.on('SIGHUP')` replaces it: vx under nohup
// stopped its run and exited 129 when the terminal closed. The POSIX idiom
// is to ask before installing; Node has no API for it, so Linux reads
// `/proc/self/status` (self is this process in any pid namespace's procfs)
// and macOS asks `sigaction` itself. Read once, before the first handler.
// SIGINT the same: a non-interactive shell starts `vx run build &` with it
// ignored, so a Ctrl-C meant for the foreground job reaches the background
// one deaf; vx's handler undid that and the Ctrl-C stopped its run, 130.

import { readFileSync } from 'node:fs'
import { dlopen, FFIType, ptr } from 'bun:ffi'

const NUMBER = { SIGHUP: 1, SIGINT: 2 } as const
const ignored = new Map<keyof typeof NUMBER, boolean>()

/** Whether this process started with `signal` ignored (inherited `SIG_IGN`). */
export function startedIgnoring(signal: keyof typeof NUMBER): boolean {
  let known = ignored.get(signal)
  if (known === undefined) {
    known = read(NUMBER[signal])
    ignored.set(signal, known)
  }
  return known
}

function read(n: number): boolean {
  try {
    if (process.platform === 'linux') {
      const mask = /^SigIgn:\s*([0-9a-f]+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))
      return mask !== null && ((BigInt(`0x${mask[1]}`) >> BigInt(n - 1)) & 1n) === 1n
    }
    if (process.platform === 'darwin') return darwinIgnored(n)
  } catch {}
  return false
}

function darwinIgnored(n: number): boolean {
  // Opened only here: bun:ffi compiles a trampoline per call site, ~1 ms.
  const lib = dlopen('/usr/lib/libSystem.B.dylib', {
    sigaction: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  })
  try {
    // `struct sigaction` opens with the handler; SIG_IGN is 1.
    const old = new BigUint64Array(4)
    return lib.symbols.sigaction(n, null, ptr(old)) === 0 && old[0] === 1n
  } finally {
    lib.close()
  }
}
