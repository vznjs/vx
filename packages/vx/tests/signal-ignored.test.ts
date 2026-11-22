// `startedIgnoring` reads the disposition this process inherited: Linux from
// /proc/self/status, macOS through sigaction. Both answers are driven, each in
// a fresh process, so the read is the one at startup. A SIGINT vx was started
// deaf to (a script's `vx run build &`, whose Ctrl-C is the foreground job's)
// stays ignored, as SIGHUP under nohup does: vx's handler undid it, and the
// Ctrl-C stopped the background run with 130.
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const MODULE = path.resolve(import.meta.dir, '..', 'src', 'util', 'hangup.ts')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const probe = (signal: string, trap: string): string => {
  const code = `import { startedIgnoring } from ${JSON.stringify(MODULE)}; console.log(startedIgnoring(${JSON.stringify(signal)}))`
  const r = Bun.spawnSync(['sh', '-c', `${trap}exec "$0" -e "$1"`, process.execPath, code], {
    env: { ...process.env },
  })
  return r.stdout.toString().trim()
}

it('startedIgnoring answers for the disposition vx was started with', () => {
  expect([probe('SIGHUP', ''), probe('SIGHUP', `trap '' HUP; `)]).toEqual(['false', 'true'])
  expect([probe('SIGINT', ''), probe('SIGINT', `trap '' INT; `)]).toEqual(['false', 'true'])
  // Each signal its own bit.
  expect([probe('SIGINT', `trap '' HUP; `), probe('SIGHUP', `trap '' INT; `)]).toEqual([
    'false',
    'false',
  ])
})

let root = ''
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-sigint-ignored-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { t: { exec: { command: 'echo started > started; sleep 1; echo done' } } } }\n`,
  })
  Bun.spawnSync([process.execPath, BIN, 'lock'], { cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const runUnder = async (trap: string): Promise<number> => {
  const proc = Bun.spawn(['sh', '-c', `${trap}exec "$0" "$1" run t --all`, process.execPath, BIN], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, CI: '' },
  })
  const started = Bun.file(path.join(root, 'packages', 'app', 'started'))
  for (let i = 0; i < 500 && !(await started.exists()); i++) await Bun.sleep(20)
  proc.kill('SIGINT')
  return proc.exited
}

it('a SIGINT vx was started deaf to leaves the run going', async () => {
  expect(await runUnder(`trap '' INT; `)).toBe(0)
}, 20_000)

it('CONTROL: a SIGINT stops a run started with it on', async () => {
  expect(await runUnder('')).toBe(130)
}, 20_000)
