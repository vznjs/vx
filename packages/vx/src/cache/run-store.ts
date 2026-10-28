// What core keeps of a run that writes a remote (2026-10-15): a failed
// task's log and the files its outputs left, an uncached task's log. Names
// come from the run id and task (`run/<id>/<task>/log`); each key is derived
// in a namespace no task key or plugin entry shares. Remote only: locally
// `vx last --log` and the working tree already hold them. No size cap (M:
// the cache is free). Plugins read them by name (`ctx.cache.getRun`).

import { xxh3hex } from '../util/index.js'
import { sayRemoteFault, type ResolvedRemote } from './remote-lane.js'
import { scopedKey } from './scoped-cache.js'
import { tarPackInto, tarSize } from './tar-stream.js'

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
 * Store `bytes` under `name` in every remote the policy writes. An entry is
 * written once; a remote's failure is said and leaves the others theirs:
 * what a run keeps here is a record, never its verdict.
 */
export async function putRunEntry(
  remotes: readonly ResolvedRemote[],
  scope: string | undefined,
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const key = scope === undefined ? runKey(name) : scopedKey(scope, runKey(name))
  let kept = false
  for (const r of remotes) {
    if (!r.write) continue
    try {
      const put = await r.remote.put(key, new Blob([bytes]), {
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

/**
 * The files at `paths` (workspace-relative) as a plain ustar archive, names
 * as given, so any `tar` reads it; null when none is left to read.
 */
export async function packRunOutputs(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<Uint8Array | null> {
  const inputs: { name: string; size: number; body: Uint8Array }[] = []
  for (const name of paths) {
    try {
      const body = await Bun.file(`${workspaceRoot}/${name}`).bytes()
      inputs.push({ name, size: body.byteLength, body })
    } catch {
      // gone since the glob: nothing to keep
    }
  }
  if (inputs.length === 0) return null
  const out = new Uint8Array(tarSize(inputs))
  tarPackInto(inputs, out)
  return out
}
