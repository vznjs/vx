// The measured-UI perf guard (audit-cycle-2026-07 §1/§5-5): drive the REAL
// dashboard (built SPA served by a real platform on ephemeral Postgres + fake
// S3, seeded through the real /v1/ingest wire) in a REAL Chromium and assert
// the 60fps bar with generous headless bounds — avg fps ≥ 40 while idle and
// while scrolling, zero >200ms long tasks after settle, zero console errors.
// The cycle-1 audit measured 20-30fps + 14 console errors/session before the
// fix waves; this guard keeps the regression from coming back silently.
//
// Skips (not fails) when the moving parts aren't present: playwright must be
// resolvable (CI sets NODE_PATH or installs it; plain `bun test` without a
// browser skips), and the single-file SPA must be built (`vx run build.ui` —
// dist/ is a gitignored build artifact).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'
import { sharedBrowser } from './helpers/playwright.js'
import { browserGate } from './helpers/browser-gate.js'

const DIST = path.join(import.meta.dir, '..', 'ui', 'dist', 'index.html')

// Structural types for the sliver of playwright we drive — the package is
// deliberately NOT a dependency (its install pulls browser downloads); it is
// imported dynamically when the environment provides it and skipped otherwise.
interface PwConsoleMessage {
  type(): string
  text(): string
}
interface PwPage {
  goto(url: string): Promise<unknown>
  waitForLoadState(state: 'networkidle'): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  mouse: {
    move(x: number, y: number): Promise<void>
    wheel(dx: number, dy: number): Promise<void>
  }
  on(event: 'console', cb: (msg: PwConsoleMessage) => void): void
  on(event: 'pageerror', cb: (err: unknown) => void): void
}
interface PwContext {
  close(): Promise<void>
  addCookies(cookies: Record<string, unknown>[]): Promise<void>
  newPage(): Promise<PwPage>
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
}
const { chromium, available } = await browserGate('ui-perf', DIST, {
  // Asserts wall-clock frame rate (>=40fps) and long-task budgets. A shared CI
  // runner measures the runner, not the dashboard — the same class this repo
  // already had to de-flake twice locally (the scale guard, the ratio guards).
  // Arming it needs a measured baseline from real runners first.
  hostPinned: 'asserts wall-clock fps on a shared runner',
})

const PROJECTS = 12
const TASKS = ['build', 'test', 'lint'] as const
const INVOCATIONS = 120
const BIG_RUN_TASKS = 400
const BIG_RUN_ID = 'perf-big-run'

function taskRow(project: string, task: string, n: number): Record<string, unknown> {
  const roll = n % 10
  const status = roll === 0 ? 'failed' : roll < 3 ? 'cache-hit' : 'success'
  return {
    taskId: `${project}#${task}`,
    project,
    task,
    status,
    cacheSource: roll < 3 && roll > 0 ? 'local' : 'miss',
    exitCode: roll === 0 ? 1 : 0,
    durationMs: 50 + ((n * 17) % 400),
    hash: `h${n % 7}`,
  }
}

function summaryFor(runId: string, startedAt: number, tasks: Record<string, unknown>[]) {
  const failed = tasks.filter((t) => t['status'] === 'failed').length
  const hits = tasks.filter((t) => t['cacheSource'] === 'local').length
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0',
      command: 'vx run ci',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: 'perf-ws',
      workspaceName: 'acme/perf',
      commitSha: `c${runId}`,
      branch: ['main', 'feat-a', 'feat-b'][startedAt % 3],
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'h',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt,
    endedAt: startedAt + 1000,
    totalDurationMs: 1000,
    taskCount: tasks.length,
    failedCount: failed,
    hitCount: hits,
    hitLocalCount: hits,
    hitRemoteCount: 0,
    exitOk: failed === 0,
    tasks,
  }
}

interface FrameSample {
  frames: number[]
  longTasks: number[]
}

// The page.evaluate closures execute in CHROMIUM, not Bun — declare just the
// browser globals they touch, module-scoped so nothing leaks into the rest of
// the (server-side) package program. A whole-file DOM lib reference would
// collide with Bun's fetch typings program-wide.
declare const window: unknown
declare const document: {
  querySelector(sel: string): {
    getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  } | null
}
declare function requestAnimationFrame(cb: (t: number) => void): number
declare function cancelAnimationFrame(id: number): void
declare class PerformanceObserver {
  constructor(cb: (list: { getEntries(): { duration: number }[] }) => void)
  observe(opts: { entryTypes: string[] }): void
}

/** Start rAF frame sampling + a longtask observer inside the page. */
async function startSampling(page: PwPage): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __perf?: { frames: number[]; long: number[]; raf: number } }
    const S = { frames: [] as number[], long: [] as number[], raf: 0 }
    w.__perf = S
    let last = performance.now()
    S.raf = requestAnimationFrame(function loop(t) {
      S.frames.push(t - last)
      last = t
      S.raf = requestAnimationFrame(loop)
    })
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) S.long.push(e.duration)
    }).observe({ entryTypes: ['longtask'] })
  })
}

async function stopSampling(page: PwPage): Promise<FrameSample> {
  return await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: number[]; raf: number } }
    cancelAnimationFrame(w.__perf.raf)
    // Drop the first few frames (sampler start-up noise).
    return { frames: w.__perf.frames.slice(5), longTasks: w.__perf.long }
  })
}

function avgFps(frames: number[]): number {
  if (frames.length === 0) return 0
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length
  return 1000 / mean
}

describe.skipIf(!available)('dashboard perf guard (real browser, measured)', () => {
  let platform: TestPlatform
  let browser: PwBrowser
  let page: PwPage
  let ctx: PwContext
  const consoleErrors: string[] = []

  beforeAll(async () => {
    // Serve the REAL built SPA — without uiHtmlPath the server returns the
    // API-only 'vx-cloud' fallback, so the browser would measure a blank page
    // and every FPS/long-task assertion would pass vacuously.
    platform = await bootPlatform({ bucket: 'perf-guard', uiHtmlPath: DIST })

    // Seed through the real ingest wire: INVOCATIONS runs plus one big run so
    // /runs and the run-detail page carry realistic row counts.
    const now = Date.now()
    const post = (body: unknown) =>
      fetch(`${platform.origin}/v1/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${platform.ciToken}`,
        },
        body: JSON.stringify(body),
      })
    for (let n = 0; n < INVOCATIONS; n++) {
      const tasks: Record<string, unknown>[] = []
      for (let p = 0; p < PROJECTS; p++) {
        for (const t of TASKS) tasks.push(taskRow(`p${String(p).padStart(2, '0')}`, t, n + p))
      }
      const res = await post(summaryFor(`perf-r${n}`, now - n * 3_600_000, tasks))
      if (!res.ok) throw new Error(`seed ingest failed: ${res.status}`)
    }
    const bigTasks: Record<string, unknown>[] = []
    for (let i = 0; i < BIG_RUN_TASKS; i++) {
      bigTasks.push(taskRow(`bp${String(i % 40).padStart(2, '0')}`, `t${i % 10}`, i))
    }
    const big = await post(summaryFor(BIG_RUN_ID, now - 60_000, bigTasks))
    if (!big.ok) throw new Error(`seed big run failed: ${big.status}`)

    browser = (await sharedBrowser(chromium!)) as unknown as PwBrowser
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addCookies([
      {
        name: 'vx_session',
        value: platform.cookie,
        domain: new URL(platform.origin).hostname,
        path: '/',
        httpOnly: true,
      },
    ])
    page = await ctx.newPage()
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))
  }, 120_000)

  // Generous: under a full-suite run these teardowns contend with every other
  // suite, and a hook that times out STRANDS the browser (bun then reports a
  // dangling process and the next browser suite boots into the wreckage).
  // The browser is shared process-wide (helpers/playwright.ts) — closing it
  // here would break every later browser suite. Only the platform is ours.
  afterAll(async () => {
    // Close OUR context, never the shared browser: an open page keeps an SSE
    // connection to the platform, and `server.stop()` waits on it — which hung
    // teardown until it timed out and took the shared browser down with it.
    await ctx?.close().catch(() => {})
    await platform?.stop()
  }, 120_000)

  it('runs page: idle polling stays ≥40fps with no long tasks', async () => {
    await page.goto(`${platform.origin}/#/runs`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1500) // settle past route mount
    await startSampling(page)
    await page.waitForTimeout(6000) // spans a 5s poll tick
    const s = await stopSampling(page)
    expect(avgFps(s.frames)).toBeGreaterThanOrEqual(40)
    expect(s.longTasks.filter((d) => d > 200)).toEqual([])
  }, 60_000)

  it('runs page: wheel scroll stays ≥40fps with no long tasks', async () => {
    await page.mouse.move(720, 500)
    await startSampling(page)
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 350)
      await page.waitForTimeout(40)
    }
    const s = await stopSampling(page)
    expect(avgFps(s.frames)).toBeGreaterThanOrEqual(40)
    expect(s.longTasks.filter((d) => d > 200)).toEqual([])
  }, 60_000)

  it('a 400-task run detail opens and scrolls without long tasks', async () => {
    await page.goto(`${platform.origin}/#/runs/${BIG_RUN_ID}`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1500)
    await page.mouse.move(720, 500)
    await startSampling(page)
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 400)
      await page.waitForTimeout(40)
    }
    const s = await stopSampling(page)
    expect(avgFps(s.frames)).toBeGreaterThanOrEqual(40)
    expect(s.longTasks.filter((d) => d > 200)).toEqual([])
  }, 60_000)

  it('insights chart hover stays ≥40fps with no long tasks', async () => {
    await page.goto(`${platform.origin}/#/insights`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1500)
    // The first LineChart's SVG box (class "block" — see charts.tsx).
    const box = await page.evaluate(() => {
      const svg = document.querySelector('svg.block')
      if (!svg) return null
      const r = svg.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })
    if (box === null) throw new Error('no LineChart rendered on /insights')
    const y = box.y + box.h / 2
    await page.mouse.move(box.x + 2, y)
    await startSampling(page)
    // Sweep across the chart — every step changes the nearest-point index, so
    // the tooltip re-binds (P8: it must not recreate its subtree per index).
    for (let i = 0; i <= 40; i++) {
      await page.mouse.move(box.x + (box.w * i) / 40, y)
      await page.waitForTimeout(16)
    }
    const s = await stopSampling(page)
    expect(avgFps(s.frames)).toBeGreaterThanOrEqual(40)
    expect(s.longTasks.filter((d) => d > 200)).toEqual([])
  }, 60_000)

  it('the whole measured session produced zero console errors', () => {
    expect(consoleErrors).toEqual([])
  })
})
