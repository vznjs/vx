// A test that times out may never have hung. On 2026-11-06 every shard on
// one Mac DTE worker lost ~20 s at once (53-64 s shards took 71-88 s, the
// passing one too) while the machine used under half its cores: three
// tests from three files timed out, each reading as its own flake, and
// their timers fired 6-12 s past their deadlines. Nothing a test does
// makes another process's timers late. This says when the process's event
// loop did not turn, with the window, so a stall reads as a stall: the
// same window in every shard of a worker is the host's; a window in one
// shard alone is that test's own blocking call.

const TICK_MS = 250
const STALL_MS = Number(process.env['VX_TEST_STALL_MS'] ?? 5_000)

let last = performance.now()
setInterval(() => {
  const now = performance.now()
  const lost = now - last - TICK_MS
  last = now
  if (lost < STALL_MS) return
  const end = Date.now()
  const iso = (ms: number): string => new Date(ms).toISOString().slice(11, 23)
  process.stderr.write(
    `stall: this test process's event loop did not turn for ${(lost / 1000).toFixed(1)} s ` +
      `(${iso(end - lost)} to ${iso(end)} UTC); a deadline across it lost that time\n`,
  )
}, TICK_MS).unref()
