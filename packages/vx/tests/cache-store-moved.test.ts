// The repository's store moves when its id does (an origin added to a repo
// that had none, a changed HOME). `vx run` opens today's store; the clear
// and a dry prune read the one the index last recorded, so the clear left
// the store the next run hits, and the dry run named other entries than the
// real prune took.

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { restoreEnv } from './helpers/env.js'
import { addProject, makeWorkspace, type Fixture } from './helpers/orchestrator-fixture.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

const BUILD = `export default { tasks: { build: {
  exec: { command: 'cat in.txt > out.txt' },
  inputs: { files: ['in.txt'] }, cache: { outputs: { files: ['out.txt'] } } } } }
`
const saved = { ...process.env }
let home: string
const made: string[] = []
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'vx-home-'))
  made.push(home)
  delete process.env['VX_CACHE_DIR']
  process.env['HOME'] = home
})
afterEach(async () => {
  restoreEnv(saved)
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function vx(f: Fixture, ...args: string[]): string[] {
  const p = Bun.spawnSync({
    cmd: [process.execPath, path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'), ...args],
    cwd: f.root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return [String(p.exitCode), p.stdout.toString(), p.stderr.toString()]
}
function build(f: Fixture): string {
  const [code, , err] = vx(f, 'run', 'build', '--all')
  expect([code, err]).toEqual(['0', ''])
  return (JSON.parse(vx(f, 'last', '--format', 'json')[1]!).tasks as Array<{ status: string }>)[0]!
    .status
}
/** A remote-less repo whose clone (with origin) filled the store an added origin moves it to. */
async function moved(cloneInput?: string): Promise<Fixture> {
  const a = await makeWorkspace('vx-store-moved-')
  made.push(a.root)
  await addProject(a.root, 'app', { config: BUILD, files: { 'in.txt': 'hi\n' } })
  gitInitCommit(a.root)
  expect(build(a)).toBe('success')
  const tmp = await realpath(os.tmpdir())
  const clone = path.join(tmp, `vx-store-moved-clone-${process.pid}-${Date.now()}`)
  made.push(clone)
  gitIn(tmp)('clone', '-q', a.root, clone)
  gitIn(clone)('remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
  if (cloneInput !== undefined)
    await Bun.write(path.join(clone, 'packages', 'app', 'in.txt'), cloneInput)
  expect(build({ ...a, root: clone })).toBe('success')
  gitIn(a.root)('remote', 'add', 'origin', 'https://github.com/acme/app.git')
  return a
}

it('`vx cache clean` clears the store the next run reads', async () => {
  const a = await moved()
  expect(vx(a, 'cache', 'clean')).toEqual(['0', expect.any(String), ''])
  expect(build(a)).toBe('success')
}, 30_000)

it('a dry prune names what the real prune takes', async () => {
  const a = await moved('hello from the clone\n'.repeat(50))
  const dry = vx(a, 'cache', 'clean', '--max-size', '1B', '--dry-run', '--format', 'json')
  const wet = vx(a, 'cache', 'clean', '--max-size', '1B', '--format', 'json')
  expect(dry).toEqual(['0', wet[1]!.replace('"dryRun":false', '"dryRun":true'), ''])
}, 30_000)
