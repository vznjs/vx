import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * What `bun build --compile` takes for a vx binary: `bin.ts` and each
 * thread entry beside it (packages/vx/vx.config.ts names the same). A
 * base older than an entry has none to name.
 */
export function vxCompileEntries(bin: string): string[] {
  const writer = path.join(path.dirname(bin), 'cache', 'history-writer.ts')
  return existsSync(writer) ? [bin, writer] : [bin]
}
