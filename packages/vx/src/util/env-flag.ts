/**
 * Whether a flag-like variable (`CI`, `GITHUB_ACTIONS`) is on: set, and not
 * `''`, `0` or `false` in any case. Several vendors set `CI=true`, and a
 * PowerShell `$false` writes `False`; each reader of CI asks this one, so a
 * run cannot be CI to one part of vx and a laptop to another.
 */
export function envFlagOn(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * The variables a CI sets, with the provider each names, most specific first:
 * the first one on decides. The generic `CI` most set comes last; Azure
 * Pipelines, Jenkins and TeamCity set no `CI`, and a run that read `CI` alone
 * called their jobs laptops and never wrote the remote cache.
 */
const CI_PROVIDERS: ReadonlyArray<readonly [envVar: string, provider: string]> = [
  ['GITHUB_ACTIONS', 'github'],
  ['GITLAB_CI', 'gitlab'],
  ['BUILDKITE', 'buildkite'],
  ['CIRCLECI', 'circleci'],
  ['TF_BUILD', 'azure'],
  ['JENKINS_URL', 'jenkins'],
  ['TEAMCITY_VERSION', 'teamcity'],
  ['CI', 'generic'],
]

/** A CI variable's "off": a laptop with `CI=no` wrote the shared remote cache. */
const CI_OFF = new Set(['', '0', 'false', 'no', 'off'])

/**
 * The CI provider `env` names, or null off CI: every reader of "is this CI"
 * (remote writes, the output flow, colours, `detectCi`) asks this. A variable
 * is on unless unset, empty, `0`, `false`, `no` or `off`, in any case.
 */
export function ciProvider(env: Record<string, string | undefined> = process.env): string | null {
  for (const [name, provider] of CI_PROVIDERS) {
    const v = env[name]
    if (v !== undefined && !CI_OFF.has(v.trim().toLowerCase())) return provider
  }
  return null
}
