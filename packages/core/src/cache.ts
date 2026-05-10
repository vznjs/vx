import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { relPosix } from './paths.js'

const CACHE_VERSION = 'nxt-cache-v1'

export interface CacheKeyInput {
  taskId: string
  command: string
  /** Names listed in the task's `env` field. */
  envNames: string[]
  /** Process env, used to look up the values for envNames. */
  processEnv: NodeJS.ProcessEnv
  /** Absolute paths to input files. */
  inputs: string[]
  workspaceRoot: string
  /** Cache keys of upstream task results, sorted, for transitive invalidation. */
  upstreamHashes: string[]
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  outputFiles: string[]
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

    const envNames = [...input.envNames].sort()
    h.update(`env-names:${envNames.join(',')}\n`)
    for (const name of envNames) {
      const value = input.processEnv[name] ?? ''
      h.update(`env:${name}=${value}\n`)
    }

    h.update(`upstream:${[...input.upstreamHashes].sort().join(',')}\n`)

    const sortedInputs = [...input.inputs].sort()
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

  async restoreOutputs(hash: string, projectDir: string): Promise<string[]> {
    const outputsDir = this.outputsDir(hash)
    if (!existsSync(outputsDir)) return []
    const restored: string[] = []
    await copyDir(outputsDir, projectDir, restored)
    return restored.sort()
  }

  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt'>
    projectDir: string
    outputFiles: string[]
  }): Promise<void> {
    const dir = this.entryDir(args.hash)
    // Atomic-ish write: stage in a sibling tmp dir, then rename.
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
    const { rename } = await import('node:fs/promises')
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

async function hashFile(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(filePath)
    s.on('data', (chunk) => h.update(chunk))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

async function copyDir(src: string, dest: string, restored: string[]): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dest, { recursive: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDir(s, d, restored)
    } else if (e.isFile()) {
      await copyFile(s, d)
      restored.push(d)
    }
  }
}
