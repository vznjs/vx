// `vx info` reports every setting and where it came from, so a variable a
// run refuses is a fact of its report: it refused instead, naming the
// variable, and printed none of the rest. The value and the refusal are
// in the settings row; every other verb still refuses.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000
const TIMEOUT_REFUSAL =
  "VX_RUN_TIMEOUT must be a duration like '500ms', '30s' or '5m', at most 24 days (got abc)"

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-info-env-'))
  await Bun.write(path.join(dir, '.vx/workspace.mjs'), 'export default {}\n')
  await Bun.write(path.join(dir, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

// No other setting variable: the row is the one under test alone.
const unset = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VX_')))

function vx(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawnSync(['bun', BIN, ...args], {
    cwd: dir,
    env: { ...unset, NO_COLOR: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('vx info under a setting variable vx refuses', () => {
  it(
    'prints the report, the value and why a run refuses it',
    () => {
      const r = vx({ VX_RUN_TIMEOUT: 'abc' }, 'info')
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      expect(r.out.split('\n').filter((l) => l.startsWith('  settings '))).toEqual([
        `  settings          run.timeout abc (VX_RUN_TIMEOUT, refused: ${TIMEOUT_REFUSAL})`,
      ])
    },
    TIMEOUT,
  )

  it(
    'one a deep reader reads, in JSON',
    () => {
      const r = vx({ VX_RUN_CONCURRENCY: 'many' }, 'info', '--format', 'json')
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      const f = JSON.parse(r.out) as {
        settings: Record<string, unknown>
        workers: { source: string }
      }
      expect(f.settings['run.concurrency']).toEqual({
        value: 'many',
        source: 'env',
        refused:
          "VX_RUN_CONCURRENCY must be a positive integer, or a share of the cores like '50%' (got many)",
      })
      expect(f.workers.source).not.toBe('env')
    },
    TIMEOUT,
  )

  it(
    'a verb that works still refuses it (control)',
    () => {
      const r = vx({ VX_RUN_TIMEOUT: 'abc' }, 'lock')
      expect(r.code).toBe(1)
      expect(r.err).toContain(TIMEOUT_REFUSAL)
    },
    TIMEOUT,
  )
})
