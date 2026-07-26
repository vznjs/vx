// Locate a Chromium driver for the browser-backed suites (the perf guard and
// the visual snapshots) WITHOUT taking playwright as a dependency — installing
// it pulls browser downloads into every `bun install`, which the repo refuses.
//
// Resolution is deliberately broad because `bun test` does not consult
// NODE_PATH the way `bun run` does, and CI images / dev containers park a
// global playwright in different prefixes. Any failure returns undefined and
// the calling suite SKIPS (never fails) — a machine without a browser still
// runs the rest of the suite.

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
 * The browser binary. This container (and the CI image, when it carries one)
 * pre-installs Chromium outside the playwright package, so the driver needs an
 * explicit `executablePath`; `VX_CHROMIUM` overrides.
 */
export function chromiumExecutablePath(): string | undefined {
  return (
    process.env['VX_CHROMIUM'] ?? process.env['PLAYWRIGHT_CHROMIUM'] ?? '/opt/pw-browsers/chromium'
  )
}
