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
import { chmodSync, lstatSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import observeArm64 from './observe/vx-observe-arm64' with { type: 'file' }
import observeX64 from './observe/vx-observe-x64' with { type: 'file' }

type Embedded = Partial<Record<NodeJS.Architecture, string>>
const EMBEDDED: Embedded = { x64, arm64 }
/** vx's own observer (`observe/vx-observe.c`), built by `scripts/build-observe.ts`. */
const OBSERVE: Embedded = { x64: observeX64, arm64: observeArm64 }

let resolved: { path: string | undefined } | undefined
let observe: Promise<string | undefined> | undefined

/**
 * The helper's path for this machine, or undefined where SRT's own lookup
 * must do (another platform or architecture, no home to copy into).
 */
export async function applySeccompPath(): Promise<string | undefined> {
  resolved ??= { path: await resolve(EMBEDDED) }
  return resolved.path
}

/** The observer's path for this machine, or undefined where there is none to run. */
export function observePath(): Promise<string | undefined> {
  observe ??= resolve(OBSERVE)
  return observe
}

async function resolve(from: Embedded): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  const embedded = from[process.arch]
  if (embedded === undefined) return undefined
  // From source the import is the file itself; an install that dropped
  // its mode leaves a file nothing can exec, copied out as an embedded one.
  if (!embedded.startsWith('/$bunfs') && runnable(embedded)) return embedded
  try {
    return await extracted(embedded)
  } catch {
    return undefined
  }
}

/**
 * The embedded helper as this user's own file, under the cache home or,
 * where that cannot be written (a CI container whose user has no home),
 * under the OS temp dir, which the sandbox needs anyway. Named by the
 * bunfs name, which carries the content's hash, so a new vx never runs an
 * old helper; kept only as a regular file of this user's, in this user's
 * own directory, that no one else may write, and of the embedded size,
 * else written again.
 */
async function extracted(embedded: string): Promise<string> {
  const uid = process.getuid?.()
  const dirs = [
    path.join(
      process.env['XDG_CACHE_HOME'] || path.join(process.env['HOME'] || os.homedir(), '.cache'),
      'vx',
      'helpers',
    ),
    path.join(os.tmpdir(), `vx-helpers-${uid}`),
  ]
  let failure: unknown
  for (const dir of dirs) {
    try {
      return await extractedTo(dir, embedded, uid)
    } catch (err) {
      failure = err
    }
  }
  throw failure
}

function runnable(file: string): boolean {
  try {
    return (statSync(file).mode & 0o111) === 0o111
  } catch {
    return false
  }
}

async function extractedTo(
  dir: string,
  embedded: string,
  uid: number | undefined,
): Promise<string> {
  const bytes = Bun.file(embedded)
  // A file from source carries no hash in its name.
  const named = embedded.startsWith('/$bunfs')
    ? path.basename(embedded).replace(/\.+$/, '')
    : `${path.basename(embedded)}-${Bun.hash(await bytes.arrayBuffer()).toString(16)}`
  const target = path.join(dir, named)
  const st = lstatSync(target, { throwIfNoEntry: false })
  const own = (): boolean => {
    const d = lstatSync(dir)
    return d.isDirectory() && d.uid === uid && (d.mode & 0o022) === 0
  }
  if (
    st?.isFile() === true &&
    st.uid === uid &&
    (st.mode & 0o022) === 0 &&
    (st.mode & 0o100) !== 0 &&
    st.size === bytes.size &&
    own()
  )
    return target
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!own()) throw new Error(`${dir} is not this user's own directory`)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, new Uint8Array(await bytes.arrayBuffer()), { mode: 0o755 })
  chmodSync(tmp, 0o755)
  renameSync(tmp, target)
  return target
}
