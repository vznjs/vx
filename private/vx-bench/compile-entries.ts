import { existsSync, readFileSync } from 'node:fs'
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

const CORE_CONFIG = path.join(import.meta.dir, 'node_modules', '@vzn', 'vx', 'vx.config.ts')

/**
 * The flags a vx release compiles with (core's `compile.bun.*` command),
 * less the target, the version define and the paths: a timed vx is the
 * binary users install. The bench had its own copy, and timed a binary
 * that loaded `.env` at start, as no release does (2026-11-23).
 */
export function vxCompileFlags(config = readFileSync(CORE_CONFIG, 'utf8')): string[] {
  const command = /`bun build --compile ([^`]*?) --target=/.exec(config)?.[1]
  if (command === undefined) throw new Error(`no compile.bun.* command in ${CORE_CONFIG}`)
  const flags = command.split(/\s+/)
  const bad = flags.filter((f) => !/^--[a-z][a-z-]*(=[a-z]+)?$/.test(f))
  if (bad.length > 0) throw new Error(`compile.bun.*: cannot read the flags ${bad.join(' ')}`)
  return flags
}
