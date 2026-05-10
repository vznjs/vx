// Content-addressed task cache.
//
// Replace this module to plug in remote storage. The contract is:
//   key()           : derive a stable hash from a task's identity + inputs
//   get(hash)       : retrieve a previous run's metadata, or null
//   restoreOutputs  : copy stored output files into the project dir
//   save            : persist outputs + metadata under a hash
//
// The orchestrator hashes outputs separately (see hashFiles) so that downstream
// cache keys reflect actual produced-file content, not just upstream cache keys.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { relPosix } from './paths.js'

const CACHE_VERSION = 'nxt-cache-v2'

export interface CacheKeyInput {
  taskId: string
  command: string
  /** Names of env vars whose values are part of the cache key. */
  envValues: Array<[name: string, value: string]>
  /** Absolute paths to project input files. */
  inputFiles: string[]
  workspaceRoot: string
  /** Output content hash of each upstream task this one depends on, sorted. */
  upstreamOutputHashes: string[]
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  outputFiles: string[]
  outputHash: string
  stdout: string
  stderr: string
  storedAt: string
}

export class Cache {
  constructor(private readonly cacheDir: string) {}

  async key(input: CacheKeyInput): Promise<string> {
    const h = createHash('sha256')
    h.update(`${CACHE_VERSION}\n`)
    h.update(`task:${input.taskId}\n`)
    h.update(`cmd:${input.command}\n`)

    h.update(`envs:${input.envValues.length}\n`)
    for (const [name, value] of input.envValues) {
      h.update(`${name}=${value}\n`)
    }

    const upstream = [...input.upstreamOutputHashes].sort()
    h.update(`upstream:${upstream.length}\n`)
    for (const u of upstream) h.update(`${u}\n`)

    const sortedInputs = [...input.inputFiles].sort()
    h.update(`inputs:${sortedInputs.length}\n`)
    for (const file of sortedInputs) {
      const rel = relPosix(input.workspaceRoot, file)
      const fileHash = await hashFile(file)
      h.update(`${rel}\0${fileHash}\n`)
    }

    return h.digest('hex')
  }

  async get(hash: string): Promise<CacheEntry | null> {
    const metaPath = this.metaPath(hash)
    if (!existsSync(metaPath)) return null
    try {
      return JSON.parse(await readFile(metaPath, 'utf8')) as CacheEntry
    } catch {
      return null
    }
  }

  async restoreOutputs(hash: string, projectDir: string): Promise<void> {
    const outputsDir = this.outputsDir(hash)
    if (!existsSync(outputsDir)) return
    await copyDir(outputsDir, projectDir)
  }

  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]
  }): Promise<void> {
    const dir = this.entryDir(args.hash)
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })

    const outputsDir = path.join(tmp, 'outputs')
    await mkdir(outputsDir, { recursive: true })
    const relOutputs: string[] = []
    for (const f of args.outputFiles) {
      const rel = path.relative(args.projectDir, f)
      const dest = path.join(outputsDir, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(f, dest)
      relOutputs.push(rel.split(path.sep).join('/'))
    }

    const meta: CacheEntry = {
      hash: args.hash,
      ...args.entry,
      outputFiles: relOutputs.sort(),
      storedAt: new Date().toISOString(),
    }
    await writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2))

    await rm(dir, { recursive: true, force: true })
    await rename(tmp, dir)
  }

  private entryDir(hash: string): string {
    return path.join(this.cacheDir, hash)
  }

  private metaPath(hash: string): string {
    return path.join(this.entryDir(hash), 'meta.json')
  }

  private outputsDir(hash: string): string {
    return path.join(this.entryDir(hash), 'outputs')
  }
}

/**
 * Hash the content of a set of files relative to a base directory.
 * Used to fingerprint a task's actual produced outputs for downstream keying.
 */
export async function hashFiles(baseDir: string, files: readonly string[]): Promise<string> {
  const h = createHash('sha256')
  h.update(`${CACHE_VERSION}-outputs\n`)
  h.update(`count:${files.length}\n`)
  const sorted = [...files].sort()
  for (const f of sorted) {
    const rel = relPosix(baseDir, f)
    const fileHash = await hashFile(f)
    h.update(`${rel}\0${fileHash}\n`)
  }
  return h.digest('hex')
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(filePath)
    s.on('data', (chunk) => h.update(chunk))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dest, { recursive: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDir(s, d)
    } else if (e.isFile()) {
      await copyFile(s, d)
    }
  }
}
