// A task failed by `inputStability.severity: 'error'` ended `failed
// (src/s.txt changed during the run, exit 1)` in the run's own output, and
// `vx last` replayed it as `failed (exit 1)`: the reason, kept with the
// failure (`inputMoved` in its JSON), was missing from the row.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      self: {
        exec: { command: 'echo more >> src/s.txt' },
        inputs: { files: ['src/**'] },
        cache: { outputs: { files: [] }, inputStability: { severity: 'error' } },
      },
      boom: { exec: { command: 'exit 3' } },
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

describe('vx last names the input that moved under a failed task', () => {
  let root = ''
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-last-moved-', git: false })
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'vx.config.mjs'), CONFIG)
    await writeFile(path.join(app, 'src', 's.txt'), 's\n')
    gitIn(root)('init', '-q')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'at the end of its row, as the run said it; another failure names none',
    async () => {
      expect((await vx(root, ['run', 'app#self', 'app#boom', '--continue=always'])).code).toBe(1)
      const rows = Object.fromEntries(
        (await vx(root, ['last'])).out
          .split('\n')
          .filter((l) => l.startsWith('  failed '))
          .map((l) => {
            const cells = l.trim().split(/\s{2,}/)
            return [cells[1], [cells[0], cells.at(-1)]]
          }),
      )
      expect(rows).toEqual({
        'app#self': ['failed (exit 1)', 'packages/app/src/s.txt changed during the run'],
        'app#boom': ['failed (exit 3)', expect.not.stringContaining('changed')],
      })
    },
    TIMEOUT,
  )
})
