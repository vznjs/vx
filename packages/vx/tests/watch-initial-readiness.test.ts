import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { isAlive } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { startWatch, until, type Watch } from './helpers/watch-loop.js'

let root = ''
let outside = ''
let watch: Watch | undefined
const lines = async (name: string): Promise<string[]> => {
  const f = Bun.file(path.join(outside, name))
  return (await f.exists()) ? (await f.text()).split('\n').filter(Boolean) : []
}
afterEach(async () => {
  if (watch) {
    watch.proc.kill('SIGKILL')
    await watch.proc.exited
    watch = undefined
  }
  for (const pid of (await lines('pids')).map(Number))
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

it('an edit restarts a server stuck before ready in the initial run', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-ready0-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-ready0-marks-'))
  const pids = path.join(outside, 'pids')
  const dir = await addProject(
    root,
    'web',
    `export default { tasks: { dev: { exec: {
    command: 'echo $$ >> ${pids}; grep -q hang src/a.txt && exec sleep 1000; echo READY; exec sleep 1000',
    persistent: { readyWhen: 'READY' },
  } } } }`,
  )
  await Bun.write(path.join(dir, 'src', 'a.txt'), 'hang\n')
  watch = startWatch(root, ['--all'], {}, 'dev')
  const w = watch
  await until(async () => (await lines('pids')).length === 1, 'the hanging server')
  await until(() => w.out().includes('vx watch: watching'), 'the armed loop')
  await writeFile(path.join(dir, 'src', 'a.txt'), 'fixed\n')
  await until(async () => (await lines('pids')).length === 2, 'the server after the fix', 10_000)
  expect(isAlive(Number((await lines('pids'))[1]))).toBe(true)
}, 30_000)

it('Ctrl-C while the initial run waits on readiness stops its server', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-ready1-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-ready1-marks-'))
  const pids = path.join(outside, 'pids')
  await addProject(
    root,
    'web',
    `export default { tasks: { dev: { exec: {
    command: 'echo $$ >> ${pids}; exec sleep 1000',
    persistent: { readyWhen: 'READY' },
  } } } }`,
  )
  watch = startWatch(root, ['--all'], {}, 'dev')
  const w = watch
  await until(() => w.out().includes('vx watch: watching'), 'the armed loop')
  const [pid] = (await lines('pids')).map(Number)
  w.proc.kill('SIGINT')
  expect(await w.proc.exited).toBe(0)
  watch = undefined
  expect(isAlive(pid!)).toBe(false)
}, 30_000)
