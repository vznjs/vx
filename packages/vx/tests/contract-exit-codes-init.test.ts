// `vx init`'s exit codes: a setup script runs it and branches on the code
// (written, or refused because files exist), yet neither cli.md nor
// contract-exit-codes recorded them. Recorded in
// `tests/contract/exit-codes-init.json`; the break law reads it by lost
// leaves, a changed code included.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-exit-codes-init.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const RECORD = path.join(import.meta.dir, 'contract', 'exit-codes-init.json')

// No Turbo or Nx config: core writes the starter itself. With one, `vx init`
// is @vzn/vx-migrate's, and the exit is its own (its suite records them).
let root: string
let dry: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-exit-init-'))
  dry = await mkdtemp(path.join(os.tmpdir(), 'vx-exit-init-dry-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(dry, { recursive: true, force: true })
})

function vx(cwd: string, ...args: string[]): number {
  return Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode
}

it('each vx init outcome exits as tests/contract/exit-codes-init.json records', () => {
  const live: Record<string, number> = {}
  live['init: an unknown flag: vx init --bogus'] = vx(root, 'init', '--bogus')
  live['init: no turbo.json or nx.json, --keep: vx init --keep'] = vx(root, 'init', '--keep')
  live['init: --dry: vx init --dry'] = vx(dry, 'init', '--dry')
  live['init: files written: vx init'] = vx(root, 'init')
  live['init: files exist: vx init'] = vx(root, 'init')
  live['init: files exist, --force: vx init --force'] = vx(root, 'init', '--force')
  writeFileSync(path.join(root, 'vx.config.ts'), 'export default { tasks: { b: 5 } }\n')
  live['init: the lock not written: vx init'] = vx(root, 'init')
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
}, 60_000)
