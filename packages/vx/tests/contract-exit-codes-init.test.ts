// `vx init`'s exit codes: a setup script runs it and branches on the code
// (written, or refused because files exist), yet neither cli.md nor
// contract-exit-codes recorded them. Recorded in
// `tests/contract/exit-codes-init.json`; the break law reads it by lost
// leaves, a changed code included.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-exit-codes-init.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const RECORD = path.join(import.meta.dir, 'contract', 'exit-codes-init.json')

let root: string
let bare: string

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-exit-init-', workspaceFile: false })
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'true' } }),
  )
  bare = await mkdtemp(path.join(os.tmpdir(), 'vx-exit-init-bare-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(bare, { recursive: true, force: true })
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
  live['init: no package.json here or above: vx init'] = vx(bare, 'init')
  live['init: an unknown flag: vx init --bogus'] = vx(root, 'init', '--bogus')
  live['init: --dry: vx init --dry'] = vx(root, 'init', '--dry')
  live['init: files written: vx init'] = vx(root, 'init')
  live['init: files exist: vx init'] = vx(root, 'init')
  live['init: files exist, --force: vx init --force'] = vx(root, 'init', '--force')
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
}, 60_000)
