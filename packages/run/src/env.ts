// Build the environment exposed to a task.
//
// Layers, lowest to highest priority:
//   1. Essentials (hard-coded allowlist for shell tooling).
//   2. passThrough: parent process.env values for the named vars.
//   3. define: explicit name=value pairs from the task config.
//
// Anything outside those three layers does not reach the child process.

const ESSENTIAL_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  'NODE_OPTIONS',
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
  passThrough: readonly string[]
  define: Readonly<Record<string, string>>
  source: NodeJS.ProcessEnv
}

export function buildIsolatedEnv(opts: BuildEnvOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}

  for (const name of ESSENTIAL_ENV) {
    const value = opts.source[name]
    if (value !== undefined) out[name] = value
  }
  for (const name of opts.passThrough) {
    const value = opts.source[name]
    if (value !== undefined) out[name] = value
  }
  for (const [name, value] of Object.entries(opts.define)) {
    out[name] = value
  }

  return out
}
