// The stall line (tests/helpers/stall-watch.ts) names a window in which a
// test process ran nothing, so a host that froze every shard at once reads
// as one stall, not as a flake per test it crossed (2026-11-06, a Mac DTE
// worker).
import path from 'node:path'
import { expect, it } from 'bun:test'

const WATCH = path.resolve(import.meta.dir, 'helpers/stall-watch.ts')

/** Stderr of a process holding the watch that lives 2.5 s, frozen for `frozenMs` of it. */
async function stderrOf(frozenMs: number): Promise<string> {
  const p = Bun.spawn(
    [process.execPath, '-e', `await import(${JSON.stringify(WATCH)}); await Bun.sleep(2_500)`],
    {
      env: { ...process.env, VX_TEST_STALL_MS: '1000' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  if (frozenMs > 0) {
    await Bun.sleep(300)
    p.kill('SIGSTOP')
    await Bun.sleep(frozenMs)
    p.kill('SIGCONT')
  }
  await p.exited
  return await new Response(p.stderr).text()
}

it('a frozen test process says how long it ran nothing, and when', async () => {
  expect(await stderrOf(1_600)).toMatch(
    /^stall: this test process's event loop did not turn for 1\.\d s \(\d\d:\d\d:\d\d\.\d{3} to \d\d:\d\d:\d\d\.\d{3} UTC\)/,
  )
})

it('CONTROL: a process that keeps running says nothing', async () => {
  expect(await stderrOf(0)).toBe('')
})
