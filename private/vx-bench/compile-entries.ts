import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * What `bun build --compile` takes for a vx binary: `bin.ts`, and the
 * history thread's entry where a base still has one (it went with the
 * per-hit rows, 2026-11-18).
 */
export function vxCompileEntries(bin: string): string[] {
  const writer = path.join(path.dirname(bin), 'history', 'history-writer.ts')
  return existsSync(writer) ? [bin, writer] : [bin]
}
