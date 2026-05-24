// Minimal argv parser. No deps. The CLI surface is small and
// command-shaped (vx <command> [args...] [--flags]), so a full
// commander-style framework would be overkill.

export interface ParsedArgs {
  /** First positional. Null when argv is empty or starts with a flag. */
  command: string | null
  /** Positional args after the command, in input order. */
  positional: readonly string[]
  /** Flags collected from the input. Boolean for bare `--flag`, string for `--flag=value`. */
  flags: Readonly<Record<string, string | true>>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {}
  const positional: string[] = []
  let command: string | null = null
  let stopFlags = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!

    if (stopFlags) {
      if (command === null) command = arg
      else positional.push(arg)
      continue
    }

    if (arg === '--') {
      stopFlags = true
      continue
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx >= 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        flags[arg.slice(2)] = true
      }
      continue
    }

    if (command === null) command = arg
    else positional.push(arg)
  }

  return { command, positional, flags }
}
