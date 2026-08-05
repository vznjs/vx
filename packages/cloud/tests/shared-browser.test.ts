// The shared-browser memo is what keeps every browser suite in one `bun test`
// process alive, so its two rules are pinned here rather than trusted:
//
//   1. a DEAD browser is never served again — it is relaunched;
//   2. no suite launches its own browser beside the shared one.
//
// Rule 1 was violated: `sharedBrowser` memoized the launch promise with no
// liveness check, so one crash was permanent for the process — every later
// suite's first `newContext` threw `Target page, context or browser has been
// closed`, and its hooks blew their 120/180s budgets. Reproduced by SIGKILLing
// the browser mid-process: `isConnected()` false, the SAME handle returned, the
// next suite dead in 2ms.
//
// Rule 2 was violated by `ui-search`, written four hours after `sharedBrowser`
// landed to stop exactly this: it launched a private Chromium, putting two in
// the process whenever it ran beside the others.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadChromium, sharedBrowser } from './helpers/playwright.js'

const TESTS_DIR = import.meta.dir

/** The main browser process: the launcher path, not one of its `--type=` children. */
function mainBrowserPid(): number | undefined {
  const ps = Bun.spawnSync(['ps', '-eo', 'pid,args'])
  for (const line of new TextDecoder().decode(ps.stdout).split('\n')) {
    if (!line.includes('/pw-browsers/chromium ')) continue
    if (line.includes('--type=')) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (Number.isInteger(pid)) return pid
  }
  return undefined
}

const chromium = await loadChromium()

describe.skipIf(chromium === undefined)('the shared browser survives its browser dying', () => {
  it('relaunches instead of handing back a corpse', async () => {
    const first = await sharedBrowser(chromium!)
    // Force a real launch — a handle with no live process proves nothing.
    await (first as unknown as { newContext(o: object): Promise<unknown> }).newContext({})
    expect(first.isConnected?.()).toBe(true)

    const pid = mainBrowserPid()
    // The precondition, asserted so a broken fixture is loud rather than green:
    // without a real process to kill this test cannot discriminate at all.
    expect(pid).toBeDefined()

    process.kill(pid!, 'SIGKILL')
    // Wait for the driver to observe the death, bounded so a hang is a failure.
    for (let i = 0; i < 60 && first.isConnected?.() !== false; i++) await Bun.sleep(100)
    expect(first.isConnected?.()).toBe(false)

    const second = await sharedBrowser(chromium!)
    expect(second).not.toBe(first) // the memo dropped the dead one
    expect(second.isConnected?.()).toBe(true)

    // What the next suite's beforeAll does. Before the fix this threw in ~2ms.
    const ctx = (await (
      second as unknown as {
        newContext(o: object): Promise<{ close(): Promise<void> }>
      }
    ).newContext({})) as { close(): Promise<void> }
    await ctx.close()
  }, 120_000)

  it('a live browser is still memoized, not relaunched per call', async () => {
    // The control: the liveness check must not turn the memo into a
    // launch-every-time, which would restore the three-Chromium contention
    // the shared browser exists to prevent.
    const a = await sharedBrowser(chromium!)
    const b = await sharedBrowser(chromium!)
    expect(b).toBe(a)
  }, 60_000)
})

/**
 * This file is the checker, not a suite — and it necessarily contains the very
 * patterns it looks for, so scanning itself reports itself. Skipped by name.
 */
const SELF = path.basename(import.meta.path)

describe('no browser suite launches its own browser', () => {
  it('every browser-backed suite goes through sharedBrowser', () => {
    const offenders: string[] = []
    for (const file of readdirSync(TESTS_DIR)) {
      if (!file.endsWith('.test.ts') || file === SELF) continue
      const src = readFileSync(path.join(TESTS_DIR, file), 'utf8')
      // A direct launch outside the helper means a second browser in the
      // process the moment this suite runs beside another.
      if (/chromium!?\s*\.\s*launch\s*\(/.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('and closes its context, never the shared browser', () => {
    const offenders: string[] = []
    for (const file of readdirSync(TESTS_DIR)) {
      if (!file.endsWith('.test.ts') || file === SELF) continue
      const src = readFileSync(path.join(TESTS_DIR, file), 'utf8')
      if (!src.includes('sharedBrowser')) continue
      // Closing the shared browser kills every suite scheduled after this one.
      if (/\bbrowser\??\.close\s*\(/.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
