// The remote seam's memory proof (docs/design/streaming-remote-2026-09.md,
// Proof 1): one ~150 MiB artifact saved through a LayeredCache over an
// in-process stub remote (the upload drained), the local copy wiped, then
// pulled back — and the process's peak RSS read at each step.
//
//   bun packages/vx-bench/stream-remote-bench.ts <vx-repo-root> [stream|bytes] [disk|memory] [MiB]
//
// `stream` is the seam since 2026-09-23 (`get` → Blob | Response, `put` ←
// Blob); `bytes` is the one before it (`get` → ArrayBuffer, `put` ←
// ArrayBuffer | Uint8Array), for a before arm run from an older checkout.
// The stub's store is `disk` by default: a `memory` store holds the artifact
// itself for the whole run in either arm, so its numbers carry the stub's
// 150 MiB on top of whatever the seam costs. The output is random bytes,
// so zstd cannot shrink the artifact.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [root, contractArg, storeArg, mibArg] = process.argv.slice(2)
const contract = contractArg ?? 'stream'
const store = storeArg ?? 'disk'
const mib = Number(mibArg ?? 150)
if (
  root === undefined ||
  !['stream', 'bytes'].includes(contract) ||
  !['disk', 'memory'].includes(store)
) {
  throw new Error('usage: stream-remote-bench.ts <vx-repo-root> [stream|bytes] [disk|memory] [MiB]')
}

interface Local {
  close(): void
  outputsPath(hash: string): string
}
interface Layered {
  save(a: {
    hash: string
    projectDir: string
    outputFiles: string[]
    entry: { taskId: string; command: string; durationMs: number; stdout: string }
  }): Promise<void>
  drainUploads(): Promise<void>
  get(hash: string, ctx: { taskId: string; command: string }): Promise<{ source: string } | null>
}
type Body = Blob | Response | ArrayBuffer | Uint8Array
const { Cache, LayeredCache } = (await import(
  path.join(root, 'packages/vx/src/cache/index.ts')
)) as {
  Cache: new (dir: string) => Local
  LayeredCache: new (
    local: Local,
    remote: unknown,
    opts: { onRemoteError: (e: Error) => void },
  ) => Layered
}

/** Peak RSS so far, in MiB. Linux reports `ru_maxrss` in KiB. */
const peakMiB = () => process.resourceUsage().maxRSS / 1024

const base = mkdtempSync(path.join(os.tmpdir(), 'vx-stream-bench-'))
const projectDir = path.join(base, 'proj')
const cacheDir = path.join(base, 'cache')
const remoteDir = path.join(base, 'remote')
mkdirSync(path.join(projectDir, 'dist'), { recursive: true })
mkdirSync(remoteDir)
const out = path.join(projectDir, 'dist', 'blob.bin')
{
  const sink = Bun.file(out).writer()
  const chunk = new Uint8Array(1 << 20)
  for (let i = 0; i < mib; i++) {
    for (let at = 0; at < chunk.length; at += 65536)
      crypto.getRandomValues(chunk.subarray(at, at + 65536))
    await sink.write(chunk)
    await sink.flush()
  }
  await sink.end()
}

const held = new Map<string, Uint8Array>()
const remote = {
  async has(hash: string) {
    return held.has(hash) || (await Bun.file(path.join(remoteDir, hash)).exists())
  },
  async put(hash: string, body: Body) {
    if (store === 'memory') {
      held.set(
        hash,
        body instanceof Blob ? await body.bytes() : new Uint8Array(body as ArrayBuffer),
      )
    } else {
      await Bun.write(path.join(remoteDir, hash), body as Blob | Uint8Array)
    }
  },
  async get(hash: string) {
    if (store === 'memory') {
      const bytes = held.get(hash)
      if (bytes === undefined) return null
      const body = contract === 'stream' ? new Response(bytes) : bytes.buffer
      return { body, durationMs: 1 }
    }
    const file = Bun.file(path.join(remoteDir, hash))
    if (!(await file.exists())) return null
    return { body: contract === 'stream' ? file : await file.arrayBuffer(), durationMs: 1 }
  },
}

const onRemoteError = (e: Error) => {
  throw e
}
const hash = 'stream-bench-artifact'
Bun.gc(true)
const baseline = peakMiB()

let local = new Cache(cacheDir)
const saving = new LayeredCache(local, remote, { onRemoteError })
await saving.save({
  hash,
  projectDir,
  outputFiles: [out],
  entry: { taskId: 'bench#build', command: 'x', durationMs: 1, stdout: '' },
})
const artifactMiB = Bun.file(local.outputsPath(hash)).size / (1 << 20)
await saving.drainUploads()
const afterSave = peakMiB()

local.close()
rmSync(cacheDir, { recursive: true, force: true })
local = new Cache(cacheDir)
const hit = await new LayeredCache(local, remote, { onRemoteError }).get(hash, {
  taskId: 'bench#build',
  command: 'x',
})
if (hit?.source !== 'remote') throw new Error(`expected a remote hit, got ${JSON.stringify(hit)}`)
const afterPull = peakMiB()
local.close()
rmSync(base, { recursive: true, force: true })

const f = (n: number) => n.toFixed(0)
console.log(
  `${contract} seam, ${store} store, ${artifactMiB.toFixed(1)} MiB artifact: peak RSS ${f(baseline)} MiB before, ${f(afterSave)} after save+upload (+${f(afterSave - baseline)}), ${f(afterPull)} after pull (+${f(afterPull - baseline)} over the run)`,
)
