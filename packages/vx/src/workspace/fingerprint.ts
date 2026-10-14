import path from 'node:path'
import { type LoadReads, readOnce } from './load-reads.js'

/**
 * The bytes of each named root file that exists: the files the plugins
 * claim (`VxPlugin.fingerprint`), read once at run start so a task that
 * rewrites one is caught (orchestrator/fingerprint-watch.ts). Core folds
 * none of them into a key; the claimant does.
 */
export async function readClaimedFiles(
  workspaceRoot: string,
  names: Iterable<string>,
  reads?: LoadReads,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  for (const f of names) {
    const bytes = await readOnce(reads, path.join(workspaceRoot, f))
    if (bytes !== null) files.set(f, bytes)
  }
  return files
}

const PATCHED = new TextEncoder().encode('"patchedDependencies"')

/**
 * The workspace-relative patch files a `bun.lock` names, sorted; none
 * outside the workspace. A lockfile without the key is not parsed (the
 * common case costs one byte search), and one that will not parse names
 * none.
 */
export function bunPatchFiles(bytes: Uint8Array): string[] {
  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(PATCHED) < 0) return []
  let doc: unknown
  try {
    doc = Bun.JSONC.parse(new TextDecoder().decode(bytes))
  } catch {
    return []
  }
  const patched = (doc as { patchedDependencies?: unknown } | null)?.patchedDependencies
  if (patched === null || typeof patched !== 'object') return []
  const out = new Set<string>()
  for (const v of Object.values(patched)) {
    if (typeof v !== 'string') continue
    const rel = path.posix.normalize(v.split(path.sep).join('/'))
    if (rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) continue
    out.add(rel)
  }
  return [...out].sort()
}
