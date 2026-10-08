// Did this process start with SIGHUP ignored? `nohup` and a supervisor
// that wants a job to outlive its terminal say so through the inherited
// disposition, and a `process.on('SIGHUP')` replaces it: vx under nohup
// stopped its run and exited 129 when the terminal closed. The POSIX idiom
// is to ask before installing; Node has no API for it, so Linux reads
// `/proc/self/status` (self is this process in any pid namespace's procfs)
// and macOS asks `sigaction` itself. Read once, before the first handler.

import { readFileSync } from 'node:fs'
import { dlopen, FFIType, ptr } from 'bun:ffi'

let ignored: boolean | undefined

export function hangupIgnored(): boolean {
  ignored ??= read()
  return ignored
}

function read(): boolean {
  try {
    if (process.platform === 'linux') {
      const mask = /^SigIgn:\s*([0-9a-f]+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))
      return mask !== null && (BigInt(`0x${mask[1]}`) & 1n) === 1n
    }
    if (process.platform === 'darwin') return darwinIgnored()
  } catch {}
  return false
}

function darwinIgnored(): boolean {
  // Opened only here: bun:ffi compiles a trampoline per call site, ~1 ms.
  const lib = dlopen('/usr/lib/libSystem.B.dylib', {
    sigaction: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  })
  try {
    // `struct sigaction` opens with the handler; SIG_IGN is 1. SIGHUP is 1.
    const old = new BigUint64Array(4)
    return lib.symbols.sigaction(1, null, ptr(old)) === 0 && old[0] === 1n
  } finally {
    lib.close()
  }
}
