// A Linux helper binary vx carries: from source the file itself, in a
// compiled vx an embedded `type: 'file'` import, which nothing can exec from
// its bunfs path, so it is copied out once per user.

import { chmodSync, lstatSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lstatOrAbsent } from './real-path.js'

/** A helper's path per architecture, as its `with { type: 'file' }` imports name it. */
export type EmbeddedBinary = Partial<Record<NodeJS.Architecture, string>>

/**
 * The helper's runnable path on this machine, or undefined where there is
 * none (another platform or architecture, no home to copy into).
 */
export async function embeddedBinaryPath(from: EmbeddedBinary): Promise<string | undefined> {
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
 * under the OS temp dir. Named by the
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
  const st = lstatOrAbsent(target)
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
