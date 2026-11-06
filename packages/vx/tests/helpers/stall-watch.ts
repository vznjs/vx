// A test that times out may never have hung. On 2026-11-06 every shard on
// one Mac DTE worker lost ~20 s at once (53-64 s shards took 71-88 s, the
// passing one too) while the machine used under half its cores: three
// tests from three files timed out, each reading as its own flake, and
// their timers fired 6-12 s past their deadlines. Nothing a test does
// makes another process's timers late. This says when the process's event
// loop did not turn, with the window, so a stall reads as a stall: the
// same window in every shard of a worker is the host's; a window in one
// shard alone is that test's own blocking call.
//
// A second thread ticks beside the main one and says which it was: a main
// thread held in a call (a sync spawn, a disk that does not answer) leaves
// the other thread running; a process the host stopped or never scheduled
// stops both.

const TICK_MS = 250
const STALL_MS = Number(process.env['VX_TEST_STALL_MS'] ?? 5_000)

// [0]: the other thread's longest late tick since the main thread last read it.
const gap = new Float64Array(new SharedArrayBuffer(8))
const TICKER = `
self.onmessage = (e) => {
  const gap = new Float64Array(e.data)
  let prev = performance.now()
  setInterval(() => {
    const now = performance.now()
    gap[0] = Math.max(gap[0], now - prev - ${TICK_MS})
    prev = now
  }, ${TICK_MS})
}
`
const ticker = new Worker(URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' })))
ticker.postMessage(gap.buffer)
ticker.unref()

const iso = (ms: number): string => new Date(ms).toISOString().slice(11, 23)

let last = performance.now()
let judging = false
setInterval(() => {
  const now = performance.now()
  const lost = now - last - TICK_MS
  last = now
  if (judging) return
  if (lost < STALL_MS) {
    gap[0] = 0
    return
  }
  const end = Date.now()
  // After a freeze either thread may run first: the verdict waits for the
  // other thread's first late tick to land.
  judging = true
  setTimeout(() => {
    judging = false
    const other = gap[0] ?? 0
    gap[0] = 0
    const which =
      other >= lost / 2
        ? 'every thread of it stopped (the host froze or did not schedule it)'
        : 'its main thread was held in a call while another thread ran'
    process.stderr.write(
      `stall: this test process's event loop did not turn for ${(lost / 1000).toFixed(1)} s ` +
        `(${iso(end - lost)} to ${iso(end)} UTC): ${which}; a deadline across it lost that time\n`,
    )
  }, 2 * TICK_MS).unref()
}, TICK_MS).unref()
