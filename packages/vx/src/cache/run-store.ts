// What core keeps of a run that writes a remote: a failed task's log and the
// files its outputs left, an uncached task's log. Names come from the run id
// and task (`run/<id>/<task>/log`); each key is derived in a namespace no task
// key or plugin entry shares. Remote only: locally `vx last --log` and the
// working tree already hold them. No size cap (M: the cache is free). Plugins
// read them by name (`ctx.cache.getRun`).

import { stat, unlink } from 'node:fs/promises'
import { xxh3hex } from '../util/index.js'
import { copyStaging } from './archive.js'
import { sayRemoteFault, type ResolvedRemote } from './remote-lane.js'
import { scopedKey } from './scoped-cache.js'
import { tarPack, tarPackInto, tarSize, type TarInput } from './tar-stream.js'

/** The name core stores a task's `part` of run `runId` under. */
export function runEntryName(runId: string, taskId: string, part: 'log' | 'outputs'): string {
  return `run/${runId}/${taskId}/${part}`
}

const runKey = (name: string): string => xxh3hex(`vx-run\0${name}`)

/** The keys `name` is read under: the default, then the scope's, as tasks read. */
export function runReadKeys(name: string, scope: string | undefined): string[] {
  const key = runKey(name)
  return scope === undefined ? [key] : [key, scopedKey(scope, key)]
}

/** Whether some remote takes this run's writes: only then does core keep run bytes. */
export function writesRunStore(remotes: readonly ResolvedRemote[]): boolean {
  return remotes.some((r) => r.write)
}

/**
 * Store `body` under `name` in every remote the policy writes. An entry is
 * written once; a remote's failure is said and leaves the others theirs:
 * what a run keeps here is a record, never its verdict.
 */
export async function putRunEntry(
  remotes: readonly ResolvedRemote[],
  scope: string | undefined,
  name: string,
  body: Blob,
): Promise<boolean> {
  const key = scope === undefined ? runKey(name) : scopedKey(scope, runKey(name))
  let kept = false
  for (const r of remotes) {
    if (!r.write) continue
    try {
      const put = await r.remote.put(key, body, {
        durationMs: 0,
        ...(scope === undefined ? {} : { scope }),
      })
      // `false`: the remote sent nothing, so nothing is kept there.
      if (put !== false) kept = true
    } catch (err) {
      sayRemoteFault(r, err instanceof Error ? err : new Error(String(err)))
    }
  }
  return kept
}

/** Outputs packing past this spool to a file, read once, not into memory. */
const SPOOL_FROM = 8 * 1024 * 1024

/**
 * The files at `paths` (workspace-relative) as a plain ustar archive, names
 * as given, so any `tar` reads it; null when none is left to read or a file
 * changed under the read. Read now, whole: a big one spools under `.vx/tmp/`
 * until `release`.
 */
export async function packRunOutputs(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<{ body: Blob; release: () => Promise<void> } | null> {
  const inputs: TarInput[] = []
  let total = 0
  for (const name of paths) {
    const file = `${workspaceRoot}/${name}`
    const st = await stat(file).catch(() => undefined)
    // gone since the glob: nothing to keep
    if (st === undefined || !st.isFile()) continue
    inputs.push({ name, size: st.size, body: Bun.file(file) })
    total += st.size
  }
  if (inputs.length === 0) return null
  if (total <= SPOOL_FROM) {
    const read: (TarInput & { body: Uint8Array })[] = []
    for (const i of inputs) {
      const body = await (i.body as Blob).bytes().catch(() => undefined)
      if (body !== undefined) read.push({ name: i.name, size: body.byteLength, body })
    }
    if (read.length === 0) return null
    const out = new Uint8Array(tarSize(read))
    tarPackInto(read, out)
    return { body: new Blob([out]), release: async () => {} }
  }
  const release = () => unlink(spool).catch(() => undefined)
  let spool = ''
  try {
    spool = copyStaging(workspaceRoot).temp('')
    const w = Bun.file(spool).writer()
    for await (const chunk of tarPack(inputs)) await w.write(chunk)
    await w.end()
  } catch {
    // a file changed or vanished mid-read, or `.vx/tmp/` refused: a record, never the verdict
    if (spool !== '') await release()
    return null
  }
  return { body: Bun.file(spool), release }
}
