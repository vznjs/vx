// Cache-hygiene contract: an interrupted run never publishes a cache
// entry for in-flight work — no partial artifacts, no entries row.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject as addProjectTo,
  makeWorkspace as makeWorkspaceRoot,
} from './helpers/workspace.js'

// The SIGTERM→SIGKILL grace is 2 s by default; every test here that proves
// the escalation would wait it out. 200 ms proves the same claim
// (`VX_KILL_GRACE_MS`, see util/settle.ts); children inherit it.
process.env['VX_KILL_GRACE_MS'] = '200'

const TIMEOUT = 30_000
const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')

let root: string

async function makeWorkspace(): Promise<void> {
  root = await makeWorkspaceRoot({ prefix: 'vx-hygiene-', workspaceFile: false })
}

async function addProject(name: string, command: string): Promise<string> {
  return addProjectTo(root, name, {
    config: `export default {
      tasks: {
        build: {
          exec: { command: ${JSON.stringify(command)} },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        },
      },
    }
    `,
    files: { 'src/in.txt': 'v1' },
  })
}

describe('interrupted run publishes nothing', () => {
  beforeEach(makeWorkspace)
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'SIGTERM mid-task → no entries row, no live or tmp artifact',
    async () => {
      // `exec` cannot apply here (the sleeper is not the last command — the
      // trailing `&& echo` is what makes this a task that WOULD publish an
      // output), so the shell stays and its sleeper is orphaned by SIGTERM.
      // Bounding the duration bounds the blast radius instead. The only
      // constraint is that the sleeper must still be running when the kill
      // lands — the task announces itself with a marker file first, and the
      // kill waits for that instead of a fixed sleep.
      await addProject('slow', 'echo started > started.txt; sleep 5 && echo done > out.txt')
      const proc = Bun.spawn({
        cmd: [process.execPath, BIN, 'run', 'build', '--all'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
      })
      const started = path.join(root, 'packages', 'slow', 'started.txt')
      const deadline = Date.now() + 10_000
      while (!(await Bun.file(started).exists())) {
        if (Date.now() > deadline) throw new Error('task never started')
        await Bun.sleep(20)
      }
      proc.kill('SIGTERM')
      await proc.exited

      const cacheDir = path.join(root, '.vx', 'cache')
      const dbPath = path.join(cacheDir, 'cache.db')
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true })
        const n = db.query('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
        db.close()
        expect(n.n).toBe(0)
      }
      const files = existsSync(cacheDir) ? await readdir(cacheDir) : []
      expect(files.filter((f) => f.endsWith('.tar.zst') || f.includes('.tmp-'))).toEqual([])
    },
    TIMEOUT,
  )
})
