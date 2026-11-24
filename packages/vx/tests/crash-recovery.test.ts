// A run killed with SIGKILL at any point (restore, save, history write)
// leaves the next run whole: it waits on no dead holder, restores no part
// of an entry as a hit, finds cache.db readable and leaves no task behind.
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root = ''
let env: Record<string, string> = {}
// In the command, so a task this run left behind is found and no other's.
const MARK = `vx-crash-${process.pid}-${Date.now()}`
const dir = () => path.join(root, 'packages', 'a')
const vx = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root, env, timeout: 60_000 })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}
const setInput = (v: string) => writeFileSync(path.join(dir(), 'in.txt'), v)
/** The outputs as bytes: every file's name and digest. */
const outputs = (): string => {
  const out = path.join(dir(), 'dist')
  const h = createHash('sha1')
  for (const f of readdirSync(out).sort())
    h.update(`${f}\0`).update(readFileSync(path.join(out, f)))
  return h.digest('hex')
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-crash-' })
  env = { ...(process.env as Record<string, string>), HOME: path.join(root, '.home') }
  await addProject(
    root,
    'a',
    `export default { tasks: { build: {
  exec: { command: 'mkdir -p dist && for i in $(seq 1 300); do head -c 4096 /dev/urandom > dist/f$i; done && cp in.txt dist/stamp # ${MARK}' },
  inputs: { files: ['in.txt'] }, outputs: { files: ['dist/**'] }, cache: true,
} } }
`,
  )
  setInput('one')
  expect(vx('lock').code).toBe(0)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a run killed at any point leaves the next run whole', async () => {
  const saved = new Map<string, string>()
  for (const v of ['one', 'two']) {
    setInput(v)
    expect(vx('run', 'build', '--all').code).toBe(0)
    saved.set(v, outputs())
  }
  // Each kill lands somewhere in start-up, the restore of the other entry,
  // its history write or the end: the next run's answer must not depend on where.
  let v = 'two'
  for (const ms of [60, 150, 250, 400, 600, 900]) {
    v = v === 'one' ? 'two' : 'one'
    setInput(v)
    const killed = Bun.spawn([process.execPath, BIN, 'run', 'build', '--all'], {
      cwd: root,
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await Bun.sleep(ms)
    killed.kill('SIGKILL')
    await killed.exited
    const next = vx('run', 'build', '--all')
    expect([ms, next.code]).toEqual([ms, 0])
    expect([ms, outputs()]).toEqual([ms, saved.get(v)!])
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    expect(db.query('pragma integrity_check').values()).toEqual([['ok']])
    db.close()
    expect(vx('last').code).toBe(0)
  }
  const left = Bun.spawnSync(['pgrep', '-f', MARK]).stdout.toString().trim()
  expect(left).toBe('')
}, 120_000)
