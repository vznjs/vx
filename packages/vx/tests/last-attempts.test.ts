// A task that passed on its second attempt ended `success flaky - 2
// attempts` in the run's own output, and `vx last` replayed it as a plain
// `success`: the one sign of a flaky task was lost on replay, though
// `runs.attempts` holds it (v23).

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      flaky: { exec: { command: 'test -f .ok || { touch .ok; exit 3; }', retries: 2 } },
      boom: { exec: { command: 'exit 4', retries: 1 } },
      once: { exec: { command: 'true', retries: 2 } },
    },
  }
`

async function vx(root: string, args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { out, code }
}

describe('vx last names a retried task’s attempts', () => {
  let root = ''
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-last-attempts-', git: false })
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'vx.config.mjs'), CONFIG)
    gitIn(root)('init', '-q')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'in the row and in the JSON; a task run once says nothing',
    async () => {
      await vx(root, ['run', 'app#flaky', 'app#boom', 'app#once', '--continue=always'])
      const rows = (await vx(root, ['last'])).out
        .split('\n')
        .filter((l) => /^ {2}(success|failed) /.test(l))
        .map((l) => {
          const cells = l.trim().split(/\s{2,}/)
          return [cells[0], cells[1], cells.at(-1)]
        })
      expect(rows).toEqual([
        ['failed (exit 4)', 'app#boom', '2 attempts'],
        ['success', 'app#flaky', '2 attempts'],
        ['success', 'app#once', expect.not.stringContaining('attempt')],
      ])
      const json = JSON.parse((await vx(root, ['last', '--format', 'json'])).out) as {
        tasks: { task: string; attempts: number | null }[]
      }
      expect(Object.fromEntries(json.tasks.map((t) => [t.task, t.attempts]))).toEqual({
        boom: 2,
        flaky: 2,
        once: null,
      })
    },
    TIMEOUT,
  )
})
