// A run that hands its servers back (`holdPersistent`, the watch loop)
// said nothing when one died afterwards: `vx watch` sat on "watching"
// over a dead dev server, while `vx run` says `vx: <id> exited with code
// <n>` for the same death. The holder's own stop() is not a death.

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const capture = () => {
  const lines: string[] = []
  const log: Logger = {
    status: (s) => void lines.push(s),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  return { lines, log }
}

const serverWorkspace = async (): Promise<string> => {
  const dir = await makeWorkspace({ prefix: 'vx-held-exit-' })
  await addProject(
    dir,
    'app',
    `export default { tasks: { dev: { exec: {
      command: 'echo ready; while [ ! -f die ]; do sleep 0.02; done; exit 3',
      persistent: { readyWhen: 'ready' },
    } } } }`,
  )
  return dir
}

it('a held server that dies on its own is said', async () => {
  root = await serverWorkspace()
  const { lines, log } = capture()
  const result = await run({
    cwd: root,
    tasks: ['app#dev'],
    holdPersistent: true,
    log,
    handleSignals: false,
  })
  expect(result.persistent?.ids).toEqual(['app#dev'])
  const before = lines.length
  await writeFile(join(root, 'packages/app/die'), '')
  const deadline = Date.now() + 5_000
  while (lines.length === before && Date.now() < deadline) await Bun.sleep(20)
  expect(lines.slice(before)).toEqual(['vx: app#dev exited with code 3'])
  await result.persistent?.stop()
}, 20_000)

// Control: the holder stopping its own servers says nothing.
it("the holder's stop() is not said as a death", async () => {
  root = await serverWorkspace()
  const { lines, log } = capture()
  const result = await run({
    cwd: root,
    tasks: ['app#dev'],
    holdPersistent: true,
    log,
    handleSignals: false,
  })
  const before = lines.length
  await result.persistent?.stop()
  await Bun.sleep(100)
  expect(lines.slice(before)).toEqual([])
}, 20_000)
