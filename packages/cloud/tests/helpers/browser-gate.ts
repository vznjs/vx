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
// One definition removes the class. It deliberately does NOT carry a
// "require a browser" switch yet: these suites are not dependably green in a
// container — runs of identical code produced different failure sets (a perf
// guard hook timeout one time, six visual shots timing out another, a clean
// 1255/0 a third), and that is un-root-caused flake rather than a property. A
// requirement would arm a gate nobody can trust. See the decision log.

import { loadChromium, type PwChromium } from './playwright.js'

export interface BrowserGate {
  /** The driver, or undefined when nothing resolved. Only read when available. */
  chromium: PwChromium | undefined
  available: boolean
}

/**
 * Resolve whether a browser-backed suite can run, and say plainly which piece
 * is missing when it cannot. Never throws — a machine without a browser still
 * runs the rest of the package.
 */
export async function browserGate(label: string, distPath: string): Promise<BrowserGate> {
  const chromium = await loadChromium()
  const distBuilt = await Bun.file(distPath).exists()
  if (chromium !== undefined && distBuilt) return { chromium, available: true }

  const missing =
    chromium === undefined
      ? distBuilt
        ? 'playwright is not resolvable'
        : 'playwright is not resolvable and ui/dist is not built'
      : 'ui/dist is not built (run `vx run build.ui`)'

  // eslint-disable-next-line no-console
  console.warn(`[${label}] skipping — ${missing}`)
  return { chromium, available: false }
}
