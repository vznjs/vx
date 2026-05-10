// Build the environment exposed to a task. Tasks run with an isolated env:
// only the essential allowlist (so shells and common tools can find what they
// need) plus the env names the task explicitly declared.
//
// Replace this module wholesale to change isolation policy.

const ESSENTIAL_ENV: readonly string[] = [
  // POSIX essentials
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Locale
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Terminal / color
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  // Node
  'NODE_OPTIONS',
  // Windows (so we work cross-platform later)
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMSPEC',
  'PATHEXT',
]

export interface BuildEnvOptions {
  declared: readonly string[]
  source: NodeJS.ProcessEnv
}

export function buildIsolatedEnv(opts: BuildEnvOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const name of ESSENTIAL_ENV) {
    const value = opts.source[name]
    if (value !== undefined) out[name] = value
  }
  for (const name of opts.declared) {
    const value = opts.source[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/**
 * Read the values of declared env names from a source env, for use in the
 * cache key. Names with no value are still included (with empty string) so
 * that "setting" vs "unsetting" the var produces different keys.
 */
export function readDeclaredEnvValues(
  declared: readonly string[],
  source: NodeJS.ProcessEnv,
): Array<[name: string, value: string]> {
  return [...declared]
    .sort()
    .map((name) => [name, source[name] ?? ''] as [string, string])
}
