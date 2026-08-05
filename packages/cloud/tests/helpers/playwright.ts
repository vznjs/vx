// Locate a Chromium driver for the browser-backed suites (the perf guard and
// the visual snapshots) WITHOUT taking playwright as a dependency — installing
// it pulls browser downloads into every `bun install`, which the repo refuses.
//
// Resolution is deliberately broad because `bun test` does not consult
// NODE_PATH the way `bun run` does, and CI images / dev containers park a
// global playwright in different prefixes. Any failure returns undefined and
// the calling suite SKIPS (never fails) — a machine without a browser still
// runs the rest of the suite.

import { existsSync } from 'node:fs'
import path from 'node:path'

/** The sliver of the playwright API the suites drive. */
export interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<{
    newContext(opts: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
  }>
}

/** Conventional global-install prefixes, tried after the explicit ones. */
const GLOBAL_ROOTS = [
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
  '/opt/node22/lib/node_modules',
  '/opt/node/lib/node_modules',
]

function rootsFromEnv(): string[] {
  const out: string[] = []
  const explicit = process.env['VX_PLAYWRIGHT_ROOT']
  if (explicit !== undefined && explicit !== '') out.push(explicit)
  for (const entry of (process.env['NODE_PATH'] ?? '').split(':')) {
    if (entry !== '') out.push(entry)
  }
  return out
}

export async function loadChromium(): Promise<PwChromium | undefined> {
  // Bare specifiers first (a local devDependency, if one ever exists), then
  // absolute paths under each known root — importing a package directory works
  // without participating in node resolution at all.
  const specs: string[] = ['playwright', 'playwright-core']
  for (const root of [...rootsFromEnv(), ...GLOBAL_ROOTS]) {
    specs.push(path.join(root, 'playwright'), path.join(root, 'playwright-core'))
  }
  for (const spec of specs) {
    try {
      const mod = (await import(spec)) as { chromium?: PwChromium }
      if (mod.chromium !== undefined) return mod.chromium
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/**
 * The browser binary, or undefined to let playwright resolve its own.
 *
 * This container pre-installs Chromium OUTSIDE the playwright package, so the
 * driver needs an explicit `executablePath`. A GitHub runner does not: there
 * `playwright install` puts the browser where playwright already looks, and
 * naming a path that does not exist is worse than naming none — `launch` would
 * throw instead of falling back, turning "no browser here" from a clean skip
 * into a failure. So the container default is used only when it is really
 * there. `VX_CHROMIUM` overrides and is NOT existence-checked: an explicit
 * request that is wrong should fail loudly rather than be silently ignored.
 */
export function chromiumExecutablePath(): string | undefined {
  const explicit = process.env['VX_CHROMIUM'] ?? process.env['PLAYWRIGHT_CHROMIUM']
  if (explicit !== undefined && explicit !== '') return explicit
  return existsSync(CONTAINER_CHROMIUM) ? CONTAINER_CHROMIUM : undefined
}

const CONTAINER_CHROMIUM = '/opt/pw-browsers/chromium'

/** A launched browser — only what the suites actually call on it. */
export interface PwBrowserHandle {
  newContext(opts: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
  /** False once the browser process is gone (crash, OOM, an explicit close). */
  isConnected?(): boolean
}

let shared: Promise<PwBrowserHandle> | undefined

/**
 * ONE Chromium for every browser-backed suite in the process.
 *
 * `bun test` runs the whole package in a single process, so a browser per suite
 * meant three live Chromiums (plus three platforms and their Postgres
 * databases) on a small box — the third launch reliably killed one of the
 * others, surfacing as "Target page, context or browser has been closed" in a
 * suite that passes on its own. Isolation lives at the CONTEXT level (own
 * cookies, own storage), which is all these suites need; the browser process
 * itself is safe to share and is by far the expensive part.
 *
 * Suites close their CONTEXT, never the browser; teardown is process exit.
 *
 * The memo is LIVENESS-CHECKED, and that is load-bearing rather than
 * defensive. Memoizing the launch promise alone made one browser death
 * permanent for the whole `bun test` process: every later suite got the corpse
 * back and its first `newContext` threw `Target page, context or browser has
 * been closed` — reproduced deterministically by SIGKILLing the browser
 * mid-process, after which `isConnected()` is false, `sharedBrowser` returns
 * the SAME handle, and the next suite fails in 2ms. A crash that should cost
 * one suite instead cost every suite after it, which is why the browser suites
 * are clean one-process-per-suite and rot when they share a process.
 *
 * `isConnected` is optional on the interface only because it is the sliver of
 * playwright's API we declare ourselves; the real Browser always has it, and a
 * handle without one is treated as alive (no worse than before).
 */
export async function sharedBrowser(chromium: PwChromium): Promise<PwBrowserHandle> {
  const existing = shared
  if (existing !== undefined) {
    const handle = await existing.catch(() => undefined)
    // A dead (or never-launched) browser must not be served again: drop it and
    // relaunch, so a crash costs the suite that hit it and nothing after.
    if (handle !== undefined && (handle.isConnected?.() ?? true)) return handle
    shared = undefined
  }
  shared ??= chromium.launch({
    headless: true,
    executablePath: chromiumExecutablePath(),
    args: ['--disable-dev-shm-usage', '--font-render-hinting=none'],
  }) as Promise<PwBrowserHandle>
  return await shared
}
