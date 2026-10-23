/**
 * A port nothing on this box listens on, from below the kernel's ephemeral
 * range (Linux 32768+, macOS 49152+). A `port: 0` bind hands out the same
 * ephemeral ports every other process gets, and on a shared CI worker
 * another shard's listener took one between the pick and the run (#4162).
 */
export function freePort(): number {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000)
    try {
      Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
      return port
    } catch {
      // held: draw again
    }
  }
}
