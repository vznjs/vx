// `vx run --help` answers under a setting variable vx refuses, and help is
// where its accepted values are read: `vx help`, `vx --help` and
// `vx help run` refused instead, naming the variable and no way to learn
// what it takes.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { BIN, vxSync } from './helpers/vx.js'

const TIMEOUT = 30_000

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-help-env-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const vx = (...args: string[]) => vxSync(dir, args, { bin: BIN, env: { VX_RUN_TIMEOUT: 'abc' } })

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
