// SRT's Linux seccomp helper (`apply-seccomp`), where a task can exec it.
// SRT finds it beside its own files, then under `npm root -g`. A compiled
// vx bundles SRT's JS but not its `vendor/`, so the published binary found
// none: every sandboxed run asked `npm root -g`, then ran with no write
// observer (a refused write named nothing, and one the task swallowed
// passed) and no AF_UNIX block. Bun embeds a `type: 'file'` import in the
// binary; from there it is copied out once per user, since nothing execs
// a bunfs path.

import arm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp' with { type: 'file' }
import x64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp' with { type: 'file' }
import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EMBEDDED: Partial<Record<NodeJS.Architecture, string>> = { x64, arm64 }

let resolved: { path: string | undefined } | undefined

/**
 * The helper's path for this machine, or undefined where SRT's own lookup
 * must do (another platform or architecture, no home to copy into).
 */
export async function applySeccompPath(): Promise<string | undefined> {
  resolved ??= { path: await resolve() }
  return resolved.path
}

async function resolve(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  const embedded = EMBEDDED[process.arch]
  if (embedded === undefined) return undefined
  // From source the import is the vendored file itself.
  if (!embedded.startsWith('/$bunfs')) return embedded
  try {
    return await extracted(embedded)
  } catch {
    return undefined
  }
}

/**
 * The embedded helper as this user's own file. Named by the bunfs name,
 * which carries the content's hash, so a new vx never runs an old helper;
 * kept only as a regular file of this user's that no one else may write,
 * and of the embedded size, else written again.
 */
async function extracted(embedded: string): Promise<string> {
  const dir = path.join(
    process.env['XDG_CACHE_HOME'] || path.join(process.env['HOME'] || os.homedir(), '.cache'),
    'vx',
    'helpers',
  )
  const target = path.join(dir, path.basename(embedded).replace(/\.+$/, ''))
  const bytes = Bun.file(embedded)
  const uid = process.getuid?.()
  const st = lstatSync(target, { throwIfNoEntry: false })
  if (
    st?.isFile() === true &&
    st.uid === uid &&
    (st.mode & 0o022) === 0 &&
    (st.mode & 0o100) !== 0 &&
    st.size === bytes.size
  )
    return target
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, new Uint8Array(await bytes.arrayBuffer()), { mode: 0o755 })
  chmodSync(tmp, 0o755)
  renameSync(tmp, target)
  return target
}
