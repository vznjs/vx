// The browser-suite availability gate, defined ONCE.
//
// Four suites need a real Chromium plus a built `ui/dist`, and each hand-rolled
// its own gate. One of the copies was WRONG: workspace-context tested
// `chromium !== null` while `loadChromium` returns `undefined`, so that clause
// was always true and the gate reduced to "is the dist built". With a dist
// present but no playwright it throws
// `TypeError: undefined is not an object (evaluating 'chromium.launch')` out of
// beforeAll — 13 failures where a skip was intended. Harmless only while CI has
// neither; the moment anything builds the dist there it goes live. Its warning
// was wrong for the same reason: the `playwright not resolvable` branch could
// never be reached, so it always blamed the dist.
//
// One definition removes the class.
//
// It previously carried no "require a browser" switch, for a stated reason:
// the suites were not dependably green in a container, so a requirement would
// arm a gate nobody could trust. THAT REASON IS VOID — the flake was a memo
// with no liveness check in `sharedBrowser` (one browser death was permanent
// for the process), and with it fixed the four suites go 30/0 in a single
// process. So the switch exists now, and CI flips it: an absent browser is a
// FAILURE, not a skip, exactly like `VX_REQUIRE_SANDBOX`. A skip is a silent
// pass, and coverage that an unrelated infrastructure change can delete under
// a green check is not coverage.
//
// Not every suite belongs in CI, and the two that do not say why HERE rather
// than being quietly absent — see `CiPolicy`.

import { loadChromium, type PwChromium } from './playwright.js'

/**
 * Whether this suite's assertions are meaningful on a CI runner.
 *
 * `'required'` — deterministic behaviour (text, routing, state). CI installs a
 * browser and builds the dist, so an absent one means the install broke.
 *
 * `{ hostPinned }` — the assertions are calibrated to the machine that made
 * them, so a runner would measure something else and fail for a reason that is
 * not a regression. Skipped when `CI` is truthy; unchanged locally, because
 * these are the suites that guard the docs screenshots and the 60fps bar and
 * making them opt-in would mean nobody runs them at all.
 */
export type CiPolicy = 'required' | { hostPinned: string }

export interface BrowserGate {
  /** The driver, or undefined when nothing resolved. Only read when available. */
  chromium: PwChromium | undefined
  available: boolean
}

/** Truthy `CI` the way the rest of the repo reads it ('0'/'false' are off). */
function inCi(): boolean {
  const v = process.env['CI']
  return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}

/**
 * Resolve whether a browser-backed suite can run, and say plainly which piece
 * is missing when it cannot. Never throws — a machine without a browser still
 * runs the rest of the package.
 */
export async function browserGate(
  label: string,
  distPath: string,
  policy: CiPolicy,
): Promise<BrowserGate> {
  const chromium = await loadChromium()
  const distBuilt = await Bun.file(distPath).exists()
  const ready = chromium !== undefined && distBuilt

  // A host-pinned suite measures something a runner cannot reproduce, so it
  // sits out CI whether or not a browser is there — and says which, so its
  // absence from a CI log is a stated decision rather than a mystery.
  if (policy !== 'required' && inCi()) {
    // eslint-disable-next-line no-console
    console.warn(`[${label}] skipping in CI — ${policy.hostPinned}`)
    return { chromium, available: false }
  }

  if (ready) return { chromium, available: true }

  const missing =
    chromium === undefined
      ? distBuilt
        ? 'playwright is not resolvable'
        : 'playwright is not resolvable and ui/dist is not built'
      : 'ui/dist is not built (run `vx run build.ui`)'

  // Required + unavailable is the case a skip would hide: CI provisions both
  // pieces, so missing one means the provisioning broke, and silently deleting
  // the suite is how coverage disappears under a green check.
  if (policy === 'required' && process.env['VX_REQUIRE_BROWSER'] === '1') {
    throw new Error(
      `[${label}] VX_REQUIRE_BROWSER=1 but ${missing} — ` +
        `install playwright + a chromium and build ui/dist, or unset the variable`,
    )
  }

  // eslint-disable-next-line no-console
  console.warn(`[${label}] skipping — ${missing}`)
  return { chromium, available: false }
}
