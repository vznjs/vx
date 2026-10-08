// A cycle whose server never printed its `readyWhen` line, with no
// `exec.timeout`, never ended, and every later edit waited behind it: the
// fix to the server could not reach it. An edit while the cycle waits on
// readiness alone now stops that cycle and starts the next (WD-15). A
// cycle running other work is never stopped.

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
afterEach(async () => {
  if (watch !== undefined) {
    watch.proc.kill('SIGKILL')
    await watch.proc.exited
    watch = undefined
  }
  for (const pid of await lines('pids').then((l) => l.map(Number)))
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/** Lines of a marker file outside the workspace: a write under a project would be an edit. */
async function lines(name: string): Promise<string[]> {
  const f = Bun.file(path.join(outside, name))
  if (!(await f.exists())) return []
  return (await f.text()).split('\n').filter(Boolean)
}

async function fixture(prep: string): Promise<string> {
  root = await makeWorkspace({ prefix: 'vx-watch-ready-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-ready-marks-'))
  const pids = path.join(outside, 'pids')
  const dir = await addProject(
    root,
    'web',
    `export default { tasks: {
      prep: { exec: { command: '${prep}' } },
      dev: {
        dependsOn: ['prep'],
        exec: {
          command: 'echo $$ >> ${pids}; grep -q hang src/a.txt && exec sleep 1000; echo READY; exec sleep 1000',
          persistent: { readyWhen: 'READY' },
        },
      },
    } }`,
  )
  await Bun.write(path.join(dir, 'src', 'a.txt'), 'ok\n')
  return dir
}

// One `time` line per run's summary: the count says how many runs have ended.
const runsEnded = (w: Watch): number => w.out().split('\n  time ').length - 1

it('an edit stops a cycle waiting on a server that never becomes ready', async () => {
  const dir = await fixture('true')
  watch = startWatch(root, ['--all'], {}, 'dev')
  const w = watch
  await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
  await writeFile(path.join(dir, 'src', 'a.txt'), 'hang\n')
  await until(async () => (await lines('pids')).length === 2, 'the hanging server')
  await writeFile(path.join(dir, 'src', 'a.txt'), 'fixed\n')
  await until(() => runsEnded(w) === 3, 'the cycle after the fix')
  const pids = (await lines('pids')).map(Number)
  expect(pids).toHaveLength(3)
  expect([isAlive(pids[1]!), isAlive(pids[2]!)]).toEqual([false, true])
  expect(w.cycles()).toBe(2)
  w.proc.kill('SIGTERM')
  expect(await w.proc.exited).toBe(0)
}, 40_000)

// Control: an edit while a plain task runs waits for the cycle, as before.
it('an edit during other work does not stop the cycle', async () => {
  const marks = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-ready-prep-'))
  try {
    const gate = path.join(marks, 'gate')
    const dir = await fixture(
      `if [ -f ${gate} ]; then rm ${gate}; echo started >> ${marks}/prep; while [ ! -f ${gate}.go ]; do sleep 0.05; done; rm ${gate}.go; fi; echo done >> ${marks}/prep`,
    )
    watch = startWatch(root, ['--all'], {}, 'dev')
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await writeFile(gate, '')
    await writeFile(path.join(dir, 'src', 'a.txt'), 'edit 1\n')
    const prep = async (): Promise<string[]> => {
      const f = Bun.file(path.join(marks, 'prep'))
      return (await f.exists()) ? (await f.text()).split('\n').filter(Boolean) : []
    }
    await until(async () => (await prep()).includes('started'), 'prep under way')
    await writeFile(path.join(dir, 'src', 'a.txt'), 'edit 2\n')
    await Bun.sleep(1000)
    await writeFile(`${gate}.go`, '')
    await until(() => runsEnded(w) === 3, 'the cycle the second edit queued')
    expect(await prep()).toEqual(['done', 'started', 'done', 'done'])
    w.proc.kill('SIGTERM')
    expect(await w.proc.exited).toBe(0)
  } finally {
    await rm(marks, { recursive: true, force: true })
  }
}, 40_000)
