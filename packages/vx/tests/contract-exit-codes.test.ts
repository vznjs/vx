// The CLI's exit codes are a 1.0 contract surface (docs/design/
// versioning-1.0.md): CI scripts branch on them. Each case below is a
// documented outcome in docs/cli.md, driven through the real binary against
// one fixture workspace, and `tests/contract/exit-codes.json` records the
// code each produced. A changed code is a reviewed diff of that file.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-exit-codes.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const RECORD = path.join(import.meta.dir, 'contract', 'exit-codes.json')

/** Each documented outcome: its cli.md section, then the arguments that reach it. */
const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['run: every task succeeds', ['run', 'build', '--all']],
  ['run: a task fails', ['run', 'fail', '--all']],
  ['run: a task no project declares', ['run', 'nope', '--all']],
  ['run: an unknown flag', ['run', 'build', '--no-such-flag']],
  ['run: nothing affected since the ref', ['run', 'build', '--affected=HEAD']],
  ['run: --dry=json', ['run', 'build', '--all', '--dry=json']],
  ['run: --graph to an unwritable path', ['run', 'build', '--all', '--graph=package.json/g.dot']],
  ['an unknown verb', ['no-such-verb']],
  ['watch: a rejected flag', ['watch', 'build', '--all', '--dry']],
  ['watch: nothing affected since the ref', ['watch', 'build', '--affected=HEAD']],
  ['cache prune: no policy', ['cache', 'prune']],
  ['cache prune: a policy', ['cache', 'prune', '--older-than', '1d']],
  ['lock: write', ['lock']],
  ['lock --check: up to date', ['lock', '--check']],
  ['show', ['show']],
  ['info', ['info']],
]

let root: string

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-exit-codes-' })
  await addProject(root, 'a', {
    config: `export default {
  tasks: {
    build: { exec: { command: 'true' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
    fail: { exec: { command: 'exit 3' } },
  },
}
`,
    files: { 'src/x.js': 'x' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('each documented outcome exits as tests/contract/exit-codes.json records', () => {
  const live: Record<string, number> = {}
  for (const [name, args] of CASES) {
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, ...args],
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    live[`${name}: vx ${args.join(' ')}`] = r.exitCode
  }
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
  // Sixteen sequential spawns: about 3 s alone, past bun's 5 s default under a loaded gate.
}, 60_000)

it('the watch exit codes name the empty --affected exit', () => {
  // `vx watch build --affected=HEAD` exits 0 without watching, as the
  // contract above records; the watch section's exit codes left it out (J2-59).
  const doc = readFileSync(path.join(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
  const watch = doc.slice(doc.indexOf('## `vx watch`'), doc.indexOf('## `vx cache prune`'))
  const codes = watch.slice(watch.indexOf('### Exit codes'))
  expect(codes.slice(0, codes.indexOf('- `1`'))).toContain('when `--affected` selects nothing')
})
