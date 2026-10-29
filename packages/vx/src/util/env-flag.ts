/**
 * Whether a flag-like variable (`CI`, `GITHUB_ACTIONS`) is on: set, and not
 * `''`, `0` or `false` in any case. Several vendors set `CI=true`, and a
 * PowerShell `$false` writes `False`; each reader of CI asks this one, so a
 * run cannot be CI to one part of vx and a laptop to another.
 */
export function envFlagOn(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}
