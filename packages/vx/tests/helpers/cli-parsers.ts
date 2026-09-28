// Each core verb's own parser, called as the CLI calls it; the error it
// returns for `argv`, or null. Shared by completions.test (flags complete
// what the parser takes) and contract-cli-surface (the values it takes).
import {
  parseInitArgs,
  parseLastArgs,
  parseLockArgs,
  parsePruneArgs,
  parseRunArgs,
  parseShowArgs,
  parseWhyArgs,
} from '../../src/cli/index.js'
import { parseInfoArgs } from '../../src/cli/info.js'
import { watchRefusal } from '../../src/cli/watch.js'

/** Each verb's own parser; the error it returns for `argv`, or null. */
export const PARSE: Readonly<Record<string, (argv: string[]) => string | null>> = {
  run: (a) => parseRunArgs(['build', ...a]).error ?? null,
  watch: (a) => {
    const parsed = parseRunArgs(['build', ...a])
    return parsed.error ?? watchRefusal(parsed)
  },
  cache: (a) => parsePruneArgs(a).error ?? null,
  lock: (a) => parseLockArgs(a).error ?? null,
  init: (a) => parseInitArgs(a).error ?? null,
  show: (a) => parseShowArgs(a).error ?? null,
  info: (a) => parseInfoArgs(a).error ?? null,
  why: (a) => parseWhyArgs(a).error ?? null,
  last: (a) => parseLastArgs(a).error ?? null,
}
