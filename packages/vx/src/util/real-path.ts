import { realpathSync } from 'node:fs'

/**
 * A path's canonical spelling. On Windows `realpathSync` keeps an 8.3
 * short name (`C:\Users\RUNNER~1\…`) where git, `fs.promises.realpath`
 * and every other reader say `runneradmin`, so one file had two
 * spellings and a key or a comparison that folds the path split on
 * them (O-16). The native call asks the OS for the final path.
 */
export function realPath(p: string): string {
  return realpathSync.native(p)
}
