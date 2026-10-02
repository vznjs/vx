import { realpathSync } from 'node:fs'

/**
 * A path's canonical spelling: the OS's own answer for the final path,
 * so a key or a comparison that folds the path sees one spelling (O-16).
 */
export function realPath(p: string): string {
  return realpathSync.native(p)
}
