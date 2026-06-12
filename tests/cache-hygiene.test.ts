// Cache-hygiene contract: an interrupted run never publishes a cache
// entry for in-flight work — no partial artifacts, no entries row.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const TIMEOUT = 30_000
const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
let log: string[]

async function makeWorkspace(): Promise<void> {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-hygiene-'))
  log = []
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
}

async function addProject(name: string, command: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default {
      tasks: {
        build: {
          exec: { command: ${JSON.stringify(command)} },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        },
      },
    }
    `,
  )
  return dir
}

describe('interrupted run publishes nothing', () => {
  beforeEach(makeWorkspace)
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'SIGTERM mid-task → no entries row, no live or tmp artifact',
    async () => {
      await addProject('slow', 'sleep 30 && echo done > out.txt')
      const proc = Bun.spawn({
        cmd: [process.execPath, BIN, 'run', 'build', '--all'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
      })
      await Bun.sleep(1200) // let discovery + spawn happen
      proc.kill('SIGTERM')
      await proc.exited

      const cacheDir = path.join(root, '.vx', 'cache')
      const dbPath = path.join(cacheDir, 'cache.db')
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true })
        const n = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
        db.close()
        expect(n.n).toBe(0)
      }
      const files = existsSync(cacheDir) ? await readdir(cacheDir) : []
      expect(files.filter((f) => f.endsWith('.tar.zst') || f.includes('.tmp-'))).toEqual([])
    },
    TIMEOUT,
  )
})
