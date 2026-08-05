// The Projects/Tasks filter box reaches the WHOLE workspace, not the fetched
// page. Drives the REAL dashboard (built SPA + real platform on ephemeral
// Postgres + fake S3, seeded through the real /v1/ingest wire) in a REAL
// Chromium against a workspace LARGER than one page, and proves the box finds
// a project the page provably omits.
//
// The projects case is discriminating by construction: `zz-needle` is seeded
// with the smallest total duration, and /v1/projects orders by SUM(duration_ms)
// DESC, so on 600 projects it can never appear in the 500-row page. A
// client-side filter over those rows cannot find it — only the debounced
// `?q` → `search=` round-trip can.
//
// Skips (never fails) without a browser or a built SPA — same posture as the
// perf guard and the visual snapshots.

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
  waitForLoadState(state: 'networkidle'): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  fill(selector: string, value: string): Promise<void>
  url(): string
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
  close(): Promise<void>
}

const { chromium, available } = await browserGate('ui-search', DIST, 'required')

/** Bigger than the 500-row page the dashboard asks for. */
const PROJECTS = 600
const NEEDLE = 'zz-needle'
const PAGE = 500
/** The slowest seeded project — first row under the default sort. */
const TOP_ROW = `pkg-${String(PROJECTS - 2).padStart(4, '0')}`

function seedSummary(): Record<string, unknown> {
  const tasks: Record<string, unknown>[] = []
  for (let i = 0; i < PROJECTS - 1; i++) {
    const project = `pkg-${String(i).padStart(4, '0')}`
    tasks.push({
      taskId: `${project}#build`,
      project,
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      // Every seeded project outranks the needle by total duration.
      durationMs: 1000 + i,
      hash: `h-${i}`,
    })
  }
  tasks.push({
    taskId: `${NEEDLE}#build`,
    project: NEEDLE,
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1,
    hash: 'h-needle',
  })
  return {
    v: 2,
    run: {
      runId: 'search-seed',
      vxVersion: '0',
      command: 'vx run build --all',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: 'search-ws',
      workspaceName: 'acme/search',
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

// The page.evaluate closure runs in CHROMIUM, not Bun — declare just the one
// browser global it touches, module-scoped (a whole-file DOM lib reference
// would collide with Bun's fetch typings program-wide).
declare const document: { body: { innerText: string } }

/** Poll the rendered text until the predicate holds (or give up). */
async function waitForText(
  page: PwPage,
  pred: (t: string) => boolean,
  ms = 15_000,
): Promise<string> {
  const deadline = Date.now() + ms
  let text = ''
  for (;;) {
    text = await page.evaluate(() => document.body.innerText)
    if (pred(text) || Date.now() > deadline) return text
    await page.waitForTimeout(250)
  }
}

describe.skipIf(!available)('filter box searches the whole workspace', () => {
  let platform: TestPlatform
  let browser: PwBrowser
  let ctx: PwContext | undefined
  let page: PwPage
  const errors: string[] = []

  beforeAll(async () => {
    platform = await bootPlatform({ bucket: 'ui-search', uiHtmlPath: DIST })
    const res = await fetch(`${platform.origin}/v1/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${platform.ciToken}`,
      },
      body: JSON.stringify(seedSummary()),
    })
    if (!res.ok) throw new Error(`seed ingest ${res.status}: ${await res.text()}`)

    // The SHARED browser, like every other browser suite. Launching a private
    // one put TWO Chromiums in the process the moment this suite ran beside
    // them — exactly the contention `sharedBrowser` was introduced to remove
    // four hours before this file was written.
    browser = (await sharedBrowser(chromium!)) as unknown as PwBrowser
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
  }, 180_000)

  afterAll(async () => {
    // The CONTEXT, never the browser — closing the shared browser would kill
    // every suite scheduled after this one in the same process.
    await ctx?.close().catch(() => {})
    await platform?.stop()
  }, 120_000)

  it('the page provably omits the needle project', async () => {
    // The precondition the browser assertion rests on — asserted against the
    // real wire so the test can never quietly stop being discriminating.
    const r = await fetch(`${platform.origin}/v1/projects?limit=${PAGE}`, {
      headers: { cookie: `vx_session=${platform.cookie}` },
    })
    const body = (await r.json()) as { projects: { project: string }[]; total: number }
    expect(body.total).toBe(PROJECTS)
    expect(body.projects).toHaveLength(PAGE)
    expect(body.projects.some((p) => p.project === NEEDLE)).toBe(false)
  }, 60_000)

  it('typing a tail project name finds it, and the notice tells the truth', async () => {
    await page.goto(`${platform.origin}/#/projects`)
    await page.waitForLoadState('networkidle').catch(() => {})
    // The table virtualizes, so only the top rows are in the DOM — TOP_ROW is
    // the slowest project (the sort default), i.e. always rendered.
    const before = await waitForText(page, (t) => t.includes(TOP_ROW))
    expect(before).toContain(TOP_ROW)
    // The page is a page — the needle is NOT in it, and the notice says so.
    expect(before).not.toContain(NEEDLE)
    expect(before).toContain(`showing ${PAGE} of ${PROJECTS} projects`)

    await page.fill('input[placeholder*="search all projects"]', NEEDLE)
    const after = await waitForText(page, (t) => t.includes(NEEDLE))
    expect(after).toContain(NEEDLE)
    // The whole page rescoped to the match set: the page-truncation notice is
    // gone and the 500 unrelated rows with it.
    expect(after).not.toContain(`showing ${PAGE} of ${PROJECTS} projects`)
    expect(after).not.toContain(TOP_ROW)
    // URL-persisted, so the search is shareable + survives a reload.
    expect(page.url()).toContain(`q=${NEEDLE}`)

    const reloaded = await page.goto(page.url()).then(async () => {
      await page.waitForLoadState('networkidle').catch(() => {})
      return await waitForText(page, (t) => t.includes(NEEDLE))
    })
    expect(reloaded).toContain(NEEDLE)
  }, 120_000)

  it('the tasks table writes the same search param', async () => {
    // Discrimination for the TASKS query lives in the analytics scale pin (the
    // DISTINCT pair scan has no defined order, so "off the page" can't be
    // asserted here); this pins the UI wiring end to end.
    await page.goto(`${platform.origin}/#/tasks`)
    await page.waitForLoadState('networkidle').catch(() => {})
    const before = await waitForText(page, (t) => t.includes('#build'))
    // Which pairs the DISTINCT scan returns is unordered, so the sentinel is
    // whichever row actually rendered rather than a hard-coded name.
    const sentinel = /pkg-\d{4}#build/.exec(before)?.[0]
    expect(sentinel).toBeDefined()
    await page.fill('input[placeholder*="search all tasks"]', `${NEEDLE}#build`)
    const after = await waitForText(page, (t) => t.includes(`${NEEDLE}#build`))
    expect(after).toContain(`${NEEDLE}#build`)
    expect(after).not.toContain(sentinel!)
    expect(page.url()).toContain('q=')
  }, 120_000)

  it('renders without console errors', () => {
    expect(errors).toEqual([])
  })
})
