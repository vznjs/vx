// Visual-regression snapshots that double as the documentation screenshots.
//
// ONE pipeline, two jobs. Each shot drives the REAL dashboard (built SPA served
// by a real platform on ephemeral Postgres + fake S3, seeded through the real
// /v1/ingest wire) in a REAL Chromium, then compares the capture against the
// committed baseline — and that baseline IS the image the docs site embeds
// (`apps/docs/src/assets/screenshots/<name>.png`). So a UI change either
// (a) fails here as a visual regression, or (b) is accepted with
// `VX_UPDATE_SNAPSHOTS=1`, which rewrites the baselines and therefore updates
// the docs screenshots in the same commit. Docs can no longer silently rot.
//
// Determinism is the whole game: the seed is anchored to a FIXED epoch (never
// Date.now()), the browser clock is frozen to that same instant (so "2h ago"
// renders identically forever), and animations/transitions are disabled before
// the shutter. What remains is anti-aliasing jitter, which `MAX_DIFF_RATIO`
// absorbs.
//
// Skips (never fails) when the moving parts aren't present — playwright must be
// resolvable and the single-file SPA must be built (`vx run build.ui`; dist/ is
// a gitignored artifact). NOTE: baselines are pinned to the environment that
// generated them — a different font set renders different text pixels. Refresh
// them in the same container that produced them (or the CI image, once one
// carries a browser); a wholesale mismatch reports as a loud diff, never a
// silent pass.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'
import { loadChromium, sharedBrowser } from './helpers/playwright.js'
import { decodePng, diffPixels } from './helpers/png.js'

const DIST = path.join(import.meta.dir, '..', 'ui', 'dist', 'index.html')
/** The docs assets ARE the baselines — one file, both jobs. */
const SNAPSHOT_DIR = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'src',
  'assets',
  'screenshots',
)
const UPDATE = process.env['VX_UPDATE_SNAPSHOTS'] === '1'
/** Fraction of pixels allowed to differ before a shot counts as regressed. */
const MAX_DIFF_RATIO = 0.005
/** 1600x1000 CSS at dsf 2 → 3200x2000 PNGs, the established docs geometry. */
const VIEWPORT = { width: 1600, height: 1000 }
const SCALE = 2

// ── the deterministic world ──────────────────────────────────────────────
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0) // Mon 2026-07-20 12:00Z, forever
const HOUR = 3_600_000
const DAY = 24 * HOUR
const WS = 'acme/checkout-monorepo'

// Structural types for the sliver of playwright we drive — the package is
// deliberately NOT a dependency; `helpers/playwright.ts` finds it when present.
interface PwConsoleMessage {
  type(): string
  text(): string
}
interface PwPage {
  goto(url: string): Promise<unknown>
  url(): string
  waitForLoadState(state: 'networkidle'): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  evaluate<T>(fn: (() => T) | string): Promise<T>
  addStyleTag(opts: { content: string }): Promise<unknown>
  screenshot(opts: { fullPage?: boolean }): Promise<Uint8Array>
  keyboard: { press(key: string): Promise<void> }
  on(event: 'console', cb: (msg: PwConsoleMessage) => void): void
  on(event: 'pageerror', cb: (err: unknown) => void): void
}
interface PwContext {
  close(): Promise<void>
  addCookies(cookies: Record<string, unknown>[]): Promise<void>
  addInitScript(script: string): Promise<void>
  newPage(): Promise<PwPage>
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
}

const chromium = await loadChromium()
const distBuilt = await Bun.file(DIST).exists()
const available = chromium !== undefined && distBuilt

// ── seed ─────────────────────────────────────────────────────────────────

interface SeedTask {
  project: string
  task: string
  status?: 'success' | 'failed'
  cacheSource?: 'miss' | 'local' | 'remote'
  durationMs?: number
  hash?: string
  attempts?: number
  /** ms offset from run start — becomes the flamegraph timeline. */
  startMs?: number
}

function taskRow(t: SeedTask): Record<string, unknown> {
  const status = t.status ?? 'success'
  const cacheSource = t.cacheSource ?? 'miss'
  const durationMs = t.durationMs ?? 400
  const hit = cacheSource === 'local' || cacheSource === 'remote'
  const row: Record<string, unknown> = {
    taskId: `${t.project}#${t.task}`,
    project: t.project,
    task: t.task,
    status: hit ? 'cache-hit' : status,
    cacheSource,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs,
    hash: t.hash ?? `h-${t.project}-${t.task}`,
    cpuMs: Math.round(durationMs * (1.15 + ((t.task.length * 7 + t.project.length * 3) % 9) / 10)),
    peakRssBytes: 90_000_000 + durationMs * 1000,
  }
  if (t.attempts !== undefined) row['attempts'] = t.attempts
  if (t.startMs !== undefined) {
    row['wallclockStartNs'] = String(t.startMs * 1_000_000)
    row['wallclockEndNs'] = String((t.startMs + durationMs) * 1_000_000)
  }
  return row
}

/** A deterministic 40-hex commit sha per run — real-looking, never random. */
function commitFor(runId: string): string {
  let h = 5381
  for (let i = 0; i < runId.length; i++) h = ((h * 33) ^ runId.charCodeAt(i)) >>> 0
  let out = ''
  let v = h
  while (out.length < 40) {
    v = (v * 1103515245 + 12345) >>> 0
    out += v.toString(16).padStart(8, '0')
  }
  return out.slice(0, 40)
}

function summary(
  runId: string,
  startedAt: number,
  branch: string,
  tasks: SeedTask[],
): Record<string, unknown> {
  const rows = tasks.map(taskRow)
  const failed = rows.filter((r) => r['status'] === 'failed').length
  const hits = rows.filter((r) => r['status'] === 'cache-hit').length
  const local = rows.filter((r) => r['cacheSource'] === 'local').length
  const totalDurationMs = rows.reduce((a, r) => a + Number(r['durationMs']), 0)
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '1.4.2',
      command: 'vx run ci --affected',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: 'visual-ws',
      workspaceName: WS,
      commitSha: commitFor(runId),
      branch,
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'runner-04',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt,
    endedAt: startedAt + totalDurationMs,
    totalDurationMs,
    taskCount: rows.length,
    failedCount: failed,
    hitCount: hits,
    hitLocalCount: local,
    hitRemoteCount: hits - local,
    exitOk: failed === 0,
    tasks: rows,
  }
}

const PROJECTS = ['checkout', 'orders', 'payments'] as const

/**
 * Ten days of history over three projects — shaped so every documented card
 * has something true to show: a flaky task (same key failed AND passed, plus a
 * within-run retry), a task that got slower recently (the "got slower"
 * detector), cache hits (hit-rate + savings), a red run on a feature branch
 * (triage + notifications), and a featured run whose per-task wallclock makes
 * the flamegraph a real timeline.
 */
function seedSummaries(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let d = 18; d >= 1; d--) {
    const day = 19 - d // 1..18, oldest first — long enough that BOTH 7-day
    // comparison windows hold the executions the movers card requires.
    const startedAt = NOW - d * DAY + 9 * HOUR
    const branch = day === 14 ? 'feat/checkout-split' : 'main'
    const tasks: SeedTask[] = []
    for (const project of PROJECTS) {
      // `orders#build` steps from ~500ms to ~1500ms in the last three days.
      const ordersSlow = project === 'orders' && day >= 16
      tasks.push({
        project,
        task: 'build',
        durationMs: ordersSlow ? 1500 : project === 'orders' ? 500 : 420 + day * 7,
        cacheSource: day % 4 === 0 && project !== 'orders' ? 'local' : 'miss',
      })
      tasks.push({
        project,
        task: 'test',
        durationMs: 900 + ((day * 37) % 220),
        // checkout#test is the flake: one key that both failed and passed.
        ...(project === 'checkout' && day === 12
          ? { status: 'failed' as const, hash: 'k-flaky' }
          : {}),
        ...(project === 'checkout' && day === 13 ? { hash: 'k-flaky' } : {}),
        ...(project === 'checkout' && day === 15 ? { attempts: 2 } : {}),
      })
      tasks.push({
        project,
        task: 'lint',
        durationMs: 210 + ((day * 13) % 60),
        cacheSource: day % 2 === 0 ? 'remote' : 'miss',
      })
    }
    if (day === 14) {
      // The red run on the feature branch — drives triage + notifications.
      tasks.push({ project: 'payments', task: 'e2e', status: 'failed', durationMs: 2400 })
    }
    out.push(summary(`run-${String(day).padStart(2, '0')}`, startedAt, branch, tasks))
  }

  // Today's CI: several runs inside the 24h window so the health tiles
  // (pass rate / hit rate) describe a working day rather than two samples.
  const today = [20, 16, 11, 7, 4]
  for (const hoursAgo of today) {
    const tasks: SeedTask[] = []
    for (const project of PROJECTS) {
      tasks.push({
        project,
        task: 'build',
        durationMs: project === 'orders' ? 1500 : 430,
        cacheSource: hoursAgo > 7 ? 'local' : 'miss',
      })
      tasks.push({
        project,
        task: 'test',
        durationMs: 950,
        cacheSource: hoursAgo > 11 ? 'remote' : 'miss',
      })
      tasks.push({ project, task: 'lint', durationMs: 230, cacheSource: 'local' })
    }
    out.push(summary(`run-h${hoursAgo}`, NOW - hoursAgo * HOUR, 'main', tasks))
  }

  // The featured run (newest): staggered wallclock so the flamegraph shows
  // real parallelism, one failure so triage has a subject.
  const featured: SeedTask[] = [
    { project: 'checkout', task: 'build', durationMs: 1250, startMs: 0 },
    { project: 'orders', task: 'build', durationMs: 1480, startMs: 40 },
    { project: 'payments', task: 'build', durationMs: 980, startMs: 75 },
    { project: 'checkout', task: 'lint', durationMs: 260, startMs: 120, cacheSource: 'local' },
    { project: 'orders', task: 'lint', durationMs: 240, startMs: 140, cacheSource: 'remote' },
    { project: 'payments', task: 'lint', durationMs: 230, startMs: 160, cacheSource: 'local' },
    { project: 'checkout', task: 'test', durationMs: 1720, startMs: 1300 },
    { project: 'orders', task: 'test', durationMs: 1340, startMs: 1540 },
    { project: 'payments', task: 'test', durationMs: 1610, startMs: 1090 },
    { project: 'payments', task: 'e2e', status: 'failed', durationMs: 2210, startMs: 2720 },
  ]
  out.push(summary('run-featured', NOW - 2 * HOUR, 'main', featured))
  return out
}

// ── the shots (name === the docs asset it feeds) ─────────────────────────

interface Shot {
  name: string
  route: string
  /** Extra interaction before the shutter (e.g. open the palette). */
  prepare?: (page: PwPage) => Promise<void>
}

const SHOTS: Shot[] = [
  { name: 'runs', route: '/#/runs' },
  { name: 'run-detail', route: '/#/runs/run-featured' },
  { name: 'insights', route: '/#/insights' },
  { name: 'project', route: `/#/projects/${encodeURIComponent('checkout')}` },
  { name: 'task-detail', route: `/#/tasks/${encodeURIComponent('checkout#test')}` },
  { name: 'cache', route: '/#/cache' },
  { name: 'compare', route: '/#/compare/run-featured' },
  { name: 'admin', route: '/#/admin' },
  {
    name: 'palette',
    route: '/#/runs',
    prepare: async (page) => {
      await page.keyboard.press('Control+k')
      await page.waitForTimeout(400)
    },
  },
]

/**
 * Fire the shutter only once the page has stopped changing: capture, wait,
 * capture again, and accept the frame when two consecutive captures are
 * byte-identical. A fixed timeout is a guess — this is a measurement, and it
 * keeps a late-painting chart from turning the guard flaky.
 */
async function stableShot(page: PwPage, tries = 8): Promise<Uint8Array> {
  let prev = await page.screenshot({ fullPage: false })
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(250)
    const next = await page.screenshot({ fullPage: false })
    if (next.length === prev.length && Bun.hash(next) === Bun.hash(prev)) return next
    prev = next
  }
  return prev
}

describe.skipIf(!available)('visual snapshots (docs screenshots)', () => {
  let platform: TestPlatform
  let browser: PwBrowser
  let page: PwPage
  let ctx: PwContext
  const errors: string[] = []

  beforeAll(async () => {
    platform = await bootPlatform({ bucket: 'visual-snapshots', uiHtmlPath: DIST })
    for (const body of seedSummaries()) {
      const res = await fetch(`${platform.origin}/v1/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${platform.ciToken}`,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`seed ingest ${res.status}: ${await res.text()}`)
    }

    browser = (await sharedBrowser(chromium!)) as unknown as PwBrowser
    ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
    // Freeze the clock BEFORE any page script runs: every relative timestamp
    // ("2h ago") is then a pure function of the seed, not of wall-clock time.
    await ctx.addInitScript(`(() => {
      const FIXED = ${NOW};
      const RealDate = Date;
      class FrozenDate extends RealDate {
        constructor(...args) { if (args.length === 0) { super(FIXED) } else { super(...args) } }
        static now() { return FIXED }
      }
      globalThis.Date = FrozenDate;
    })()`)
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
    // Booting pg + fake S3 + seeding + launching Chromium routinely exceeds
    // the CLI default when the whole cloud suite is contending for the box.
  }, 180_000)

  /**
   * Every shot lives under the same document — only the hash differs — and a
   * hash-only `goto` is a SAME-DOCUMENT navigation, so the `load` event it
   * waits for never fires again. In isolation the wait happens to resolve;
   * under a loaded full-suite run it hangs until the test times out (which
   * then strands the browser). Drive the hash router directly instead.
   */
  const navigate = async (route: string): Promise<void> => {
    const target = `${platform.origin}${route}`
    const sameDocument = page.url().split('#')[0] === target.split('#')[0]
    if (sameDocument) {
      const hash = route.slice(route.indexOf('#') + 1)
      await page.evaluate(`location.hash = ${JSON.stringify(hash)}`)
    } else {
      await page.goto(target)
    }
  }

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

  for (const shot of SHOTS) {
    it(`${shot.name} matches its committed baseline`, async () => {
      await navigate(shot.route)
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1200)
      // Motion is the enemy of a stable shutter.
      await page.addStyleTag({
        content:
          '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
      })
      await shot.prepare?.(page)
      const shotBytes = await stableShot(page)

      const baselinePath = path.join(SNAPSHOT_DIR, `${shot.name}.png`)
      if (UPDATE) {
        await Bun.write(baselinePath, shotBytes)
        return
      }

      const baselineFile = Bun.file(baselinePath)
      expect(
        await baselineFile.exists(),
        `missing baseline ${shot.name}.png — regenerate with VX_UPDATE_SNAPSHOTS=1`,
      ).toBe(true)

      const actual = decodePng(shotBytes)
      const baseline = decodePng(new Uint8Array(await baselineFile.arrayBuffer()))
      const diff = diffPixels(baseline, actual)
      if (diff.ratio > MAX_DIFF_RATIO) {
        // Park the capture so the drift can be eyeballed; NEVER write into
        // the docs assets on a failure — only the update mode does that.
        const out = path.join(tmpdir(), `vx-visual-${shot.name}.actual.png`)
        await Bun.write(out, shotBytes)
        const detail =
          diff.sizeMismatch !== undefined
            ? `size ${diff.sizeMismatch.a} → ${diff.sizeMismatch.b}`
            : `${(diff.ratio * 100).toFixed(2)}% of pixels (${diff.differing}/${diff.total})`
        throw new Error(
          `visual regression on ${shot.name}: ${detail}. Capture written to ${out}. ` +
            `If the change is intended, refresh the baselines (which also updates the ` +
            `docs screenshots): VX_UPDATE_SNAPSHOTS=1 bun test tests/visual.test.ts`,
        )
      }
    }, 90_000)
  }

  it('renders every documented page without console errors', () => {
    expect(errors).toEqual([])
  })
})
