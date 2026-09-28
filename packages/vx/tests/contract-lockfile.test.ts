// A committed `vx-lock.json` is a 1.0 contract surface
// (docs/design/versioning-1.0.md): users check it in, and CI runs
// `vx lock --check && vx run … --frozen` against it. `tests/contract/
// vx-lock.json` is the lock this vx writes for one fixture workspace. A
// later vx must write the same bytes (so a format change is a reviewed diff
// of that file) and must accept the committed one: `--check` passes and
// `--frozen` runs from it. A change to how `configHash` is taken, or to
// `LOCKFILE_VERSION`, fails here before it fails every user's CI.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-lockfile.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const RECORD = path.join(import.meta.dir, 'contract', 'vx-lock.json')

let root: string

const vx = (mode: string, ...args: string[]): { code: number | null; out: string } => {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', LOCK_FIXTURE_MODE: mode },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-contract-' })
  // Every config field a lock carries a value for, and an env read the
  // lock freezes at lock time.
  await addProject(root, 'lib', {
    config: `export default {
  tasks: {
    build: {
      description: 'compile',
      exec: { command: 'echo lib', env: { passThrough: ['HOME'] }, timeout: 60000, retries: 1 },
      cache: { inputs: { files: ['src/**'], env: ['LOCK_FIXTURE_MODE'] }, outputs: { files: ['dist/**'] } },
    },
  },
}
`,
    files: { 'src/a.ts': 'a' },
  })
  await addProject(root, 'app', {
    config: `const mode = process.env.LOCK_FIXTURE_MODE ?? 'dev'
export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'echo app ' + mode },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
    dev: { exec: { command: 'echo dev', persistent: {} } },
  },
}
`,
    deps: { lib: 'workspace:*' },
    files: { 'src/b.ts': 'b' },
  })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('vx lock writes tests/contract/vx-lock.json byte for byte', () => {
  expect(vx('ci', 'lock').code).toBe(0)
  const live = readFileSync(path.join(root, 'vx-lock.json'), 'utf8')
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, live)
  }
  expect(live).toBe(readFileSync(RECORD, 'utf8'))
})

it('the committed lock passes --check and drives a --frozen run', () => {
  writeFileSync(path.join(root, 'vx-lock.json'), readFileSync(RECORD, 'utf8'))
  const check = vx('ci', 'lock', '--check')
  expect([check.code, check.out]).toEqual([0, check.out])
  // Run under another mode: a live evaluation would print `app local`, so
  // `app ci` proves the config came from the lock.
  const frozen = vx('local', 'run', 'build', '--all', '--frozen', '--output-logs=full')
  expect(frozen.code).toBe(0)
  expect(
    ['app ci', 'app local', 'lib'].filter(
      (s) => frozen.out.includes(`echo ${s}`) || frozen.out.includes(s),
    ),
  ).toEqual(['app ci', 'lib'])
}, 30_000)
