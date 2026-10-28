// The remote cache a Turbo or Nx repo already uses, as the repo shows it,
// so the workspace file a migration writes keeps sharing it: native or
// keep, from `vx init` or `bunx @vzn/vx-migrate` (2026-10-14). Nx
// Cloud's wire is Nx's own, so it is named, never declared.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** The cache plugin each runner's remote speaks through, from this package. */
export const REMOTE_CACHE = { turbo: 'turboCache', nx: 'nxCache' } as const

/** The variable each runner's self-hosted remote cache is set by, as its plugin reads it. */
const REMOTE_CACHE_ENV = { turbo: 'TURBO_TOKEN', nx: 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER' } as const

const CI_FILES = ['.gitlab-ci.yml', '.circleci/config.yml']

/**
 * Where the repo shows a remote cache its runner uses, or undefined:
 * turbo.json's enabled `remoteCache`, a `turbo link`ed `.turbo/config.json`,
 * or a CI file that sets the runner's cache variable (a local repo holds
 * no token; CI does).
 */
export function remoteCacheSignal(root: string, runner: 'turbo' | 'nx'): string | undefined {
  if (runner === 'turbo') {
    for (const f of ['turbo.json', 'turbo.jsonc']) {
      let rc: unknown
      try {
        rc = (
          Bun.JSONC.parse(readFileSync(path.join(root, f), 'utf8')) as { remoteCache?: unknown }
        )?.remoteCache
        // quiet: a local config file: none read is none declared
      } catch {
        continue
      }
      if (typeof rc === 'object' && rc !== null) {
        // Turned off in turbo.json is off, whatever CI sets.
        if ((rc as { enabled?: unknown }).enabled === false) return undefined
        return `${f} names a remoteCache`
      }
    }
    // `turbo link` writes the team here (gitignored, on the machine that
    // linked); turboCache() reads it, so a linked repo has a remote cache.
    let linked: unknown
    try {
      linked = JSON.parse(readFileSync(path.join(root, '.turbo', 'config.json'), 'utf8'))
      // quiet: a local config file: none read is none linked
    } catch {}
    if (
      typeof linked === 'object' &&
      linked !== null &&
      Object.entries(linked).some(
        ([k, v]) => /^(teamid|teamslug|token)$/i.test(k) && typeof v === 'string' && v !== '',
      )
    ) {
      return '.turbo/config.json links a team (turbo link)'
    }
  }
  const variable = REMOTE_CACHE_ENV[runner]
  // A line that sets it (`TURBO_TOKEN: …`, `TURBO_TOKEN=…`), not one that
  // names it: a comment or a doc line counted as "sets" (J's lead).
  const sets = new RegExp(`^(?!\\s*#).*\\b${variable}\\s*[:=]`, 'm')
  const workflows = new Bun.Glob('.github/workflows/*.{yml,yaml}')
  const files = [...workflows.scanSync({ cwd: root, dot: true })].sort().concat(CI_FILES)
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(path.join(root, f), 'utf8')
      // quiet: a local config file: none read is none declared
    } catch {
      continue
    }
    if (sets.test(text)) return `${f} sets ${variable}`
  }
  return undefined
}

/**
 * nx.json names an Nx Cloud workspace (`nxCloudId`, `nxCloudAccessToken`,
 * or the legacy `nx-cloud` runner). Its wire is Nx's own, so a user who
 * expected their remote cache under vx heard nothing and ran cold.
 */
function usesNxCloud(root: string): boolean {
  let json: {
    nxCloudId?: unknown
    nxCloudAccessToken?: unknown
    tasksRunnerOptions?: { default?: { runner?: unknown } }
  } | null
  try {
    json = Bun.JSONC.parse(readFileSync(path.join(root, 'nx.json'), 'utf8')) as typeof json
    // quiet: a local config file: none read is none declared
  } catch {
    return false
  }
  const set = (v: unknown) => typeof v === 'string' && v !== ''
  const runner = json?.tasksRunnerOptions?.default?.runner
  return (
    set(json?.nxCloudId) ||
    set(json?.nxCloudAccessToken) ||
    (typeof runner === 'string' && /(^|\/)nx-cloud$/.test(runner))
  )
}

/**
 * The report's line about the remote cache, or undefined: the cache plugin
 * declared (`declared`), the one a kept file still lacks, or Nx Cloud.
 */
export function remoteCacheNote(
  root: string,
  runner: 'turbo' | 'nx',
  declared: boolean,
): string | undefined {
  const signal = remoteCacheSignal(root, runner)
  const cache = REMOTE_CACHE[runner]
  if (signal !== undefined) {
    return declared
      ? `${cache}(): ${signal}, so vx shares that remote cache (token: the variable, else the OS keychain).`
      : `${signal}: add ${cache}() from @vzn/vx-migrate to its plugins and vx shares that remote cache.`
  }
  return runner === 'nx' && usesNxCloud(root)
    ? 'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).'
    : undefined
}
