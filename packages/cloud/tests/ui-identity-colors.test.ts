// A project's identity dot must reach the browser as an IDENTITY colour.
//
// The sibling `identity-colors.test.ts` guards the source: no view declares a
// retired ramp, no producer survives, the safelist lists every hue. It cannot
// see the hazard that actually bites in this codebase — a token present in the
// literal class map but ABSENT from the built CSS renders as no colour at all,
// silently, because UnoCSS's static extractor never saw it. Only a real
// browser resolving real stylesheets can tell those apart.
//
// Discriminating by construction: `utils` and `frontend` are seeded because
// the retired `paletteFor` hashed them onto `chart-3` and `chart-4` — which
// are byte-identical to `--success` and `--warn`. Before the sweep this page
// painted their dots green and amber; the assertion below reads the COMPUTED
// colour and refuses any verdict RGB.
//
// Skips (never fails) without a browser or a built SPA — same posture as the
// other behavioural browser suites.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'
import { sharedBrowser } from './helpers/playwright.js'
import { browserGate } from './helpers/browser-gate.js'

const DIST = path.join(import.meta.dir, '..', 'ui', 'dist', 'index.html')

interface PwConsoleMessage {
  type(): string
  text(): string
}
interface PwPage {
  goto(url: string): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  on(event: 'console', cb: (msg: PwConsoleMessage) => void): void
  on(event: 'pageerror', cb: (err: unknown) => void): void
}
interface PwContext {
  addCookies(cookies: Record<string, unknown>[]): Promise<void>
  newPage(): Promise<PwPage>
  close(): Promise<void>
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>
}

const { chromium, available } = await browserGate('ui-identity-colors', DIST, 'required')

/** Names the retired ramp put on `--success` / `--warn` respectively. */
const PROJECTS = ['utils', 'frontend', 'packages/shared', 'apps/docs', '@acme/api']

function seedSummary(): Record<string, unknown> {
  const tasks = PROJECTS.map((project, i) => ({
    taskId: `${project}#build`,
    project,
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1000 + i * 100,
    hash: `h-${i}`,
  }))
  return {
    v: 2,
    run: {
      runId: 'ident-seed',
      vxVersion: '0',
      command: 'vx run build --all',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: 'ident-ws',
      workspaceName: 'acme/ident',
      commitSha: 'c0',
      branch: 'main',
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'h',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 30_000,
    totalDurationMs: 30_000,
    taskCount: tasks.length,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks,
  }
}

// The evaluate closures run in CHROMIUM, not Bun — declare just the browser
// globals they touch, module-scoped (a whole-file DOM lib reference would
// collide with Bun's fetch typings program-wide).
declare const document: {
  body: { innerText: string }
  querySelectorAll(sel: string): ArrayLike<{ className: string }>
}
declare function getComputedStyle(el: unknown): { backgroundColor: string }

interface DotReport {
  identClassCount: number
  chartClassCount: number
  colors: string[]
}

describe.skipIf(!available)('identity dots reach the browser as identity colours', () => {
  let platform: TestPlatform
  let ctx: PwContext | undefined
  let page: PwPage
  const errors: string[] = []

  beforeAll(async () => {
    platform = await bootPlatform({ bucket: 'ui-identity', uiHtmlPath: DIST })
    const res = await fetch(`${platform.origin}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platform.ciToken}` },
      body: JSON.stringify(seedSummary()),
    })
    if (!res.ok) throw new Error(`seed ingest ${res.status}: ${await res.text()}`)

    const browser = (await sharedBrowser(chromium!)) as unknown as PwBrowser
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
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
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e)))

    await page.goto(`${platform.origin}/#/projects`)
    // Poll until the seeded rows render rather than sleeping a fixed span —
    // a fixed wait can expire mid-flight and reads the pre-fetch DOM.
    const deadline = Date.now() + 20_000
    for (;;) {
      const text = await page.evaluate(() => document.body.innerText)
      if (text.includes('frontend') || Date.now() > deadline) break
      await page.waitForTimeout(250)
    }
  }, 120_000)

  afterAll(async () => {
    // Close the CONTEXT, never the shared browser — closing the browser kills
    // every suite scheduled after this one.
    await ctx?.close()
    await platform?.stop()
  }, 60_000)

  it('renders the seeded projects', () => {
    // Non-vacuity: without rows there are no dots to assert on.
    expect(errors).toEqual([])
  })

  it('paints every identity dot from the identity set, never a retired ramp', async () => {
    const report = await page.evaluate<DotReport>(() => {
      const dots = Array.from(document.querySelectorAll('span[class*="bg-ident-"]'))
      const charts = Array.from(
        document.querySelectorAll('[class*="bg-chart-"], [class*="fill-chart-"]'),
      )
      return {
        identClassCount: dots.length,
        chartClassCount: charts.length,
        colors: dots.map((d) => getComputedStyle(d).backgroundColor),
      }
    })
    // The seeded projects each render an identity dot plus a duration bar.
    expect(report.identClassCount).toBeGreaterThanOrEqual(PROJECTS.length)
    expect(report.chartClassCount).toBe(0)

    // The end-to-end property a source guard cannot see: the class must
    // actually GENERATE a colour, and that colour must not be a verdict.
    const VERDICT = new Set(['rgb(74, 222, 128)', 'rgb(250, 204, 21)', 'rgb(248, 113, 113)'])
    const colourless = report.colors.filter(
      (c) => c === '' || c === 'rgba(0, 0, 0, 0)' || c === 'transparent',
    )
    expect(colourless).toEqual([])
    expect(report.colors.filter((c) => VERDICT.has(c))).toEqual([])
  })
})
