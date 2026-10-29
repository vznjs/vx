// 2026-10-15: the region stays up through the run's tail and the footer
// replaces it in place; uploads still running show as `⇡`, last in the
// remote part. vx's own steps render as tasks: a live row once one passes
// 150 ms, below the worker rows and bounded by no worker slot, then a list
// row. A quicker step shows nowhere, and no step is counted as a task.

import { describe, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/report/status-line.js'

function tty(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: true,
    columns: 100,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

const ERASE = '\x1b[J'

// A loaded runner can fire the 100 ms ticker late; wait for the draw itself.
async function until(drawn: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!drawn() && performance.now() < deadline) await Bun.sleep(25)
}

describe('uploads still running at the end of a run', () => {
  const start = () => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {})
    const key = { uploading: 1, failures: [] as string[] }
    const traffic = { inFlight: 1, keys: new Map([['h-a', key]]) }
    log.runStart?.({
      total: 1,
      concurrency: 1,
      context: {
        version: '0.0.0',
        packageCount: 1,
        remoteCacheEnabled: true,
        cache: { local: true, localWrite: true, remote: true, traffic, notDownloaded: () => 0 },
      },
    })
    const a = {
      id: 'p#a',
      deps: [],
      projectName: 'p',
      taskName: 'a',
      requested: true,
      config: { exec: { command: 'true' }, cache: {} },
    } as unknown as TaskNode
    log.taskStart?.(a)
    log.taskComplete(a, {
      node: a,
      status: 'success',
      exitCode: 0,
      durationMs: 5,
      hash: 'h-a',
      saved: true,
    } as TaskOutcome)
    const settle = () => {
      key.uploading = 0
      traffic.inFlight = 0
    }
    return { out, log, settle }
  }

  it('the region keeps the footer through the tail; the footer replaces it', async () => {
    const { out, log, settle } = start()
    log.runEnd?.()
    await Bun.sleep(50)
    const shown = out.text().slice(out.text().lastIndexOf(ERASE))
    expect(shown).toContain('remote 1⇡')
    // The worker rows are gone: the graph is done.
    expect(shown).not.toContain('p#a')
    // A warning in the tail prints above the region, which stays.
    log.status('warning')
    expect(out.text().slice(out.text().lastIndexOf('warning'))).toContain('remote 1⇡')
    settle()
    log.runDone?.()
    log.status('footer')
    const after = out.text()
    // Erased before the footer, and never drawn again.
    expect(after.endsWith('footer\n')).toBe(true)
    expect(after.slice(0, -'footer\n'.length).endsWith(ERASE)).toBe(true)
    await Bun.sleep(150)
    expect(out.text()).toBe(after)
  })
})

describe("vx's own steps", () => {
  const start = (concurrency = 1) => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { forceFloorMs: 0 })
    return { out, log, concurrency }
  }
  const region = (out: { text(): string }): string =>
    out.text().slice(out.text().lastIndexOf(ERASE))

  it('one quicker than 150 ms shows nowhere', async () => {
    const { out, log } = start()
    log.runStart?.({ total: 1, concurrency: 1 })
    log.stepStart?.('vx:keys')
    await Bun.sleep(20)
    log.stepEnd?.('vx:keys', { durationMs: 20, ok: true })
    await Bun.sleep(150)
    expect(out.text()).not.toContain('vx:keys')
  })

  it('a slow one runs below the worker rows, beside a running task at concurrency 1', async () => {
    const { out, log } = start()
    log.runStart?.({ total: 1, concurrency: 1 })
    const a = {
      id: 'p#a',
      deps: [],
      projectName: 'p',
      taskName: 'a',
      requested: true,
      config: { exec: { command: 'true' }, cache: {} },
    } as unknown as TaskNode
    log.taskStart?.(a)
    log.stepStart?.('vx:uploads')
    await until(() => region(out).includes('vx:uploads'))
    const live = region(out)
    expect(live).toContain('p#a')
    expect(live).toContain('vx:uploads')
    expect(live.indexOf('vx:uploads')).toBeGreaterThan(live.indexOf('p#a'))
    log.stepEnd?.('vx:uploads', { durationMs: 300, ok: true })
    // Its list row, on the task grid: time, `success`, `internal` for the cache word.
    expect(out.text()).toMatch(/⏺︎ +300ms success internal vx:uploads\n/)
    expect(region(out)).not.toContain('running internal vx:uploads')
  })

  it('one before the run starts draws the region with no footer', async () => {
    const { out, log } = start()
    log.stepStart?.('vx:load')
    await until(() => /running internal vx:load/.test(out.text()))
    expect(out.text()).toMatch(/running internal vx:load/)
    expect(out.text()).not.toContain('tasks')
    log.stepEnd?.('vx:load', { durationMs: 300, ok: true })
    log.runStart?.({ total: 0, concurrency: 1 })
    log.runEnd?.()
    log.runDone?.()
  })

  it('no step is counted as a task', async () => {
    const { out, log } = start()
    log.runStart?.({ total: 1, concurrency: 1 })
    log.stepStart?.('vx:history')
    await Bun.sleep(200)
    log.stepEnd?.('vx:history', { durationMs: 200, ok: false })
    expect(out.text()).toMatch(/◼︎ +200ms failed  internal vx:history\n/)
    expect(region(out)).toContain('1 total')
    expect(region(out)).not.toContain('failed ·')
  })
})

// `--output-logs hash-only` is one line per task: a step's row (and the
// list header over it) broke the audit trail a script reads off a terminal.
it('hash-only prints no row for a step that passed', () => {
  const out = tty()
  const log = defaultLogger({ enabled: false }, { mode: 'hash-only' }, out, { forceFloorMs: 0 })
  log.runStart?.({ total: 1, concurrency: 1 })
  log.stepStart?.('vx:uploads')
  log.stepEnd?.('vx:uploads', { durationMs: 300, ok: true })
  expect(out.text()).not.toMatch(/success internal vx:uploads\n/)
  // The list's header; the live region's own names `blocked` too.
  expect(out.text()).not.toMatch(/time status +cache +task\n/)
})
