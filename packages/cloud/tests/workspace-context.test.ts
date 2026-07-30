// The workspace is the SCOPE of every page — every analytics row the dashboard
// renders is `WHERE workspace_id = <the sidebar selection>`. This drives the
// real dashboard in a real Chromium against a real platform and pins that the
// context is (a) always stated, at 0, 1 and N workspaces, and (b) actually
// rescopes the data when switched.
//
// Why it exists: the switcher used to be a corner chip hidden below 2
// workspaces, so a reader had no way to tell which workspace filled the page,
// and a second repo's first push appeared out of nowhere. Every other suite
// seeds ONE workspaceId, which is exactly why that went unnoticed.
//
// Skips (never fails) without playwright or a built SPA, like the other
// browser suites.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'
import { loadChromium, sharedBrowser } from './helpers/playwright.js'

const DIST = path.join(import.meta.dir, '..', 'ui', 'dist', 'index.html')
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0)

const chromium = await loadChromium()
const hasDist = await Bun.file(DIST).exists()
const available = chromium !== null && hasDist
if (!available) {
  console.warn(
    `[workspace-context] skipped — ${chromium === null ? 'playwright not resolvable' : 'ui/dist not built (vx run build.ui)'}`,
  )
}

interface Pg {
  goto(url: string): Promise<unknown>
  reload(): Promise<unknown>
  waitForLoadState(s: string): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  evaluate(script: string): Promise<unknown>
  fill(selector: string, value: string): Promise<void>
  on(event: string, fn: (arg: never) => void): void
}

function summary(wsId: string, wsName: string, runId: string, project: string, at: number) {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '1.4.2',
      command: 'vx run ci',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: wsId,
      workspaceName: wsName,
      commitSha: 'a'.repeat(40),
      branch: 'main',
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'runner-01',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: at,
    endedAt: at + 500,
    totalDurationMs: 500,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        project,
        task: 'build',
        status: 'success',
        durationMs: 500,
        exitCode: 0,
        cacheSource: 'miss',
        hash: 'h1',
        attempts: 1,
      },
    ],
  }
}

describe.skipIf(!available)('workspace context (multi-workspace dashboard)', () => {
  let platform: TestPlatform
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: { newContext(o: unknown): Promise<any>; close(): Promise<void> }
  let page: Pg
  let ctx: {
    close(): Promise<void>
    newPage(): Promise<unknown>
    addCookies(c: unknown[]): Promise<void>
    addInitScript(s: string): Promise<void>
  }
  const errors: string[] = []

  const ingest = async (
    wsId: string,
    wsName: string,
    runId: string,
    project: string,
    at: number,
  ) => {
    const r = await fetch(`${platform.origin}/v1/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${platform.ciToken}`,
      },
      body: JSON.stringify(summary(wsId, wsName, runId, project, at)),
    })
    if (!r.ok) throw new Error(`ingest ${r.status}: ${await r.text()}`)
  }

  /**
   * A hash-only `goto` is a same-document navigation, so module state (and the
   * memoized workspace list) survives — reload to model a genuinely fresh tab.
   */
  const freshLoad = async (route = '/#/runs') => {
    await page.goto(`${platform.origin}${route}`)
    // `goto` between two hash URLs is a same-document navigation, so the app
    // keeps running and its URL-mirror effect can rewrite the address before
    // the reload — which would then load a URL this test never asked for.
    // Stamp the exact target in, THEN reload, so the fresh document boots
    // from precisely the route under test.
    await page.evaluate(
      `history.replaceState(null, '', ${JSON.stringify(platform.origin + route)})`,
    )
    await page.reload()
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1500)
  }

  const url = async (): Promise<string> => (await page.evaluate(`location.href`)) as string

  const wsIds = async (): Promise<Record<string, string>> => {
    const r = await fetch(`${platform.origin}/v1/workspaces`, {
      headers: { cookie: `vx_session=${platform.cookie}` },
    })
    const body = (await r.json()) as { workspaces: { id: string; name: string }[] }
    return Object.fromEntries(body.workspaces.map((w) => [w.name, w.id]))
  }

  const contextText = async (): Promise<string> =>
    (await page.evaluate(
      `(() => { const a = document.querySelector('aside'); return a ? a.innerText : '' })()`,
    )) as string

  const bodyText = async (): Promise<string> =>
    (await page.evaluate(`document.body.innerText`)) as string

  beforeAll(async () => {
    platform = await bootPlatform({ bucket: 'ws-context', uiHtmlPath: DIST })
    browser = (await sharedBrowser(chromium!)) as never
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
    page = (await ctx.newPage()) as Pg
    page.on('console', (m: never) => {
      const msg = m as unknown as { type(): string; text(): string }
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (e: never) => errors.push(String(e)))
    // Booting pg + fake S3 + Chromium routinely exceeds the CLI default when
    // the whole cloud suite is contending for the box.
  }, 180_000)

  // The browser is shared process-wide (helpers/playwright.ts) — closing it
  // here would break every later browser suite. Only the platform is ours.
  afterAll(async () => {
    // Close OUR context, never the shared browser: an open page keeps an SSE
    // connection to the platform, and `server.stop()` waits on it — which hung
    // teardown until it timed out and took the shared browser down with it.
    await ctx?.close().catch(() => {})
    await platform?.stop()
  }, 120_000)

  // Ordered: each step builds the world the next one needs.
  it('an org with NO workspace says so instead of rendering a silent void', async () => {
    await freshLoad()
    // The server clamps a workspace-less org to the nil uuid, so every page is
    // empty by construction; only the context row can explain why.
    expect(await contextText()).toContain('No workspace yet')
  })

  it('a SINGLE workspace is still named — the scope is never implicit', async () => {
    await ingest('client-alpha', 'acme/alpha', 'run-alpha-1', 'checkout', NOW - 7200_000)
    await freshLoad()
    const sidebar = await contextText()
    expect(sidebar).toContain('acme/alpha')
    expect(sidebar).not.toContain('No workspace yet')
  })

  it('a second workspace appears with a count, and reads scope to one of them', async () => {
    await ingest('client-beta', 'acme/beta', 'run-beta-1', 'billing', NOW - 3600_000)
    await freshLoad()
    const sidebar = await contextText()
    // Most-recently-active wins when nothing is pinned — mirroring the server.
    expect(sidebar).toContain('acme/beta')
    expect(sidebar).toContain('2 workspaces')
    const body = await bodyText()
    expect(body).toContain('run-beta')
    expect(body).not.toContain('run-alph')
  })

  it('switching the workspace rescopes the data, not just the label', async () => {
    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll('aside button')]
        .find((b) => b.title && b.title.startsWith('Workspace:'))
      btn.click()
    })()`)
    await page.waitForTimeout(300)
    await page.evaluate(`(() => {
      const item = [...document.querySelectorAll('aside button')]
        .find((b) => b.innerText.includes('acme/alpha'))
      item.click()
    })()`)
    await page.waitForTimeout(2500)

    expect(await contextText()).toContain('acme/alpha')
    const body = await bodyText()
    expect(body).toContain('run-alph')
    expect(body).not.toContain('run-bet')
  })

  // The context must ride the URL, or a shared link opens against the
  // RECIPIENT's workspace and silently shows them different data.
  it('mirrors the selected workspace into the URL', async () => {
    await freshLoad()
    const ids = await wsIds()
    expect(await url()).toContain(`ws=${ids['acme/alpha']}`)
  })

  it('a link carrying ?ws= wins over the local preference', async () => {
    const ids = await wsIds()
    // Persisted selection is alpha (previous test); the link names beta.
    await freshLoad(`/#/runs?ws=${ids['acme/beta']}`)
    expect(await contextText()).toContain('acme/beta')
    const body = await bodyText()
    expect(body).toContain('run-beta')
    expect(body).not.toContain('run-alph')
  })

  it('keeps the scope across an internal link that knows nothing about it', async () => {
    const ids = await wsIds()
    await page.evaluate(`(() => {
      const a = [...document.querySelectorAll('aside a')].find((x) => x.textContent.includes('Insights'))
      a.click()
    })()`)
    await page.waitForTimeout(1200)
    const after = await url()
    expect(after).toContain('#/insights')
    expect(after).toContain(`ws=${ids['acme/beta']}`)
  })

  it('adds ?ws= without eating the params a view already owns', async () => {
    const ids = await wsIds()
    await freshLoad('/#/insights?window=7d')
    const after = await url()
    expect(after).toContain('window=7d')
    expect(after).toContain(`ws=${ids['acme/beta']}`)
  })

  it('says so when a link names a workspace this account cannot see', async () => {
    // A well-formed uuid that belongs to no workspace here.
    await freshLoad('/#/runs?ws=00000000-0000-4000-8000-00000000dead')
    const body = await bodyText()
    expect(body).toContain("can't see")
    // ...and it fell back rather than rendering an empty page.
    expect(await contextText()).toContain('acme/')
    expect(await url()).not.toContain('dead')
  })

  // Deleting the workspace you are LOOKING AT must not strand the dashboard
  // pointing at a scope that no longer exists.
  it('deleting the selected workspace lands on a valid scope, not a dead one', async () => {
    const ids = await wsIds()
    const doomed = ids['acme/beta']!
    // The previous cases left beta selected; confirm that before deleting it,
    // or this test would prove nothing about the SELECTED workspace.
    await freshLoad('/#/admin?section=workspaces')
    expect(await contextText()).toContain('acme/beta')

    const slug = (await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-testid="workspaces-table"] tbody tr')]
        .find((tr) => tr.innerText.includes(${JSON.stringify(doomed)}))
      const cells = row.querySelectorAll('td')
      const s = cells[0].innerText.trim()
      ;[...row.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Delete').click()
      return s
    })()`)) as string
    await page.waitForTimeout(200)
    await page.fill('[data-testid="workspace-delete-input"]', slug)
    await page.evaluate(`document.querySelector('[data-testid="workspace-delete-submit"]').click()`)
    // Poll for the fallback rather than sleeping a fixed 2s. This test failed
    // once in a full-suite run reading the PRE-delete sidebar ("2 workspaces"),
    // i.e. reporting "fell back to the wrong scope" when the truth would be
    // "hadn't fallen back yet" — the delete is a round-trip plus a refetch plus
    // a replace-navigation. STATED HONESTLY: that cause is consistent with the
    // failure text but is NOT reproduced — the fixed-wait version passes 11/0
    // isolated and under 6-way CPU contention, so this is a robustness change,
    // not a verified fix. Polling is strictly better regardless: it cannot
    // expire mid-flight, and it returns as soon as the state lands.
    const deadline = Date.now() + 15_000
    let sidebar = await contextText()
    while (sidebar.includes('acme/beta') && Date.now() < deadline) {
      await page.waitForTimeout(100)
      sidebar = await contextText()
    }

    // The context picker fell back to the surviving workspace…
    expect(sidebar).toContain('acme/alpha')
    expect(sidebar).not.toContain('acme/beta')
    // …the URL no longer names the deleted scope…
    const after = await url()
    expect(after).not.toContain(doomed)
    expect(after).toContain(`ws=${ids['acme/alpha']!}`)
    // …and it does NOT accuse the user of following a link they can't see:
    // they deleted it themselves, one click ago.
    expect(await bodyText()).not.toContain("can't see")

    // The surviving scope is live, not just labelled.
    await page.evaluate(`(() => {
      const a = [...document.querySelectorAll('aside a')].find((x) => x.textContent.includes('Runs'))
      a.click()
    })()`)
    await page.waitForTimeout(1500)
    const body = await bodyText()
    expect(body).toContain('run-alph')
    expect(body).not.toContain('run-beta')
  })

  it('renders all of that with no console errors', () => {
    expect(errors).toEqual([])
  })
})
