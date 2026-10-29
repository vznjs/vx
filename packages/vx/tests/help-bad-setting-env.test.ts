// `vx run --help` answers under a setting variable vx refuses, and help is
// where its accepted values are read: `vx help`, `vx --help` and
// `vx help run` refused instead, naming the variable and no way to learn
// what it takes.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-help-env-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function vx(...args: string[]) {
  const p = Bun.spawnSync(['bun', BIN, ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1', VX_RUN_TIMEOUT: 'abc' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('help under a setting variable vx refuses', () => {
  for (const args of [['help'], ['--help'], ['-h'], ['help', 'run'], ['run', '--help']]) {
    it(
      `vx ${args.join(' ')} prints the help`,
      () => {
        const r = vx(...args)
        expect(r.err).toBe('')
        expect(r.code).toBe(0)
        expect(r.out).toContain('Usage:')
      },
      TIMEOUT,
    )
  }

  it(
    'a verb that works still refuses it (control)',
    () => {
      const r = vx('lock')
      expect(r.code).toBe(1)
      expect(r.err).toContain('VX_RUN_TIMEOUT must be a duration')
    },
    TIMEOUT,
  )
})
