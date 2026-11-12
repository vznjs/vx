// The second Distributed task execution, held by vx's own run(): it uses
// only `@vzn/vx`, so the contract is wide enough for anyone to build one.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-distribute-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pkg(name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    config.replace('export default {', `export default { name: ${JSON.stringify(name)},`),
  )
  return dir
}

/** `.vx/workspace.mjs` declaring `distribute(workers)`, then `vx lock`. */
async function workspace(workers: number): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'distribute.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { distribute } from ${from}\nexport default { plugins: [distribute(${workers})] }\n`,
  )
  const vx = path.join(path.dirname(new URL(import.meta.resolve('@vzn/vx')).pathname), 'bin.ts')
  const lock = Bun.spawnSync({ cmd: [process.execPath, vx, 'lock'], cwd: root })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([0, ''])
}

const quiet = (out: string[] = []): Logger => ({
  status() {},
  taskStart() {},
  taskStdout: (_n, chunk) => void out.push(chunk),
  taskStderr: (_n, chunk) => void out.push(chunk),
  taskComplete() {},
})

it('runs each task on a worker, streams its output, and caches it as the floor would', async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: {
      one: { exec: { command: 'echo one > one.txt; echo said-one' }, inputs: { files: [] }, outputs: { files: ['one.txt'] }, cache: true },
      two: { exec: { command: 'echo two > two.txt; echo said-two >&2' }, inputs: { files: [] }, outputs: { files: ['two.txt'] }, cache: true },
    } }`,
  )
  await workspace(2)
  const out: string[] = []
  const first = await run({
    cwd: root,
    tasks: ['one', 'two'],
    log: quiet(out),
    handleSignals: false,
  })
  expect(
    first.outcomes
      .map((o) => [o.node.id, o.status, o.placement?.where?.startsWith('w#')])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  ).toEqual([
    ['a#one', 'success', true],
    ['a#two', 'success', true],
  ])
  expect(out.sort((x, y) => x.localeCompare(y))).toEqual(['said-one\n', 'said-two\n'])
  expect(await Bun.file(path.join(dir, 'one.txt')).text()).toBe('one\n')
  await rm(path.join(dir, 'one.txt'))
  const again = await run({ cwd: root, tasks: ['one'], log: quiet(), handleSignals: false })
  expect(again.outcomes.map((o) => [o.node.id, o.status])).toEqual([['a#one', 'cache-hit']])
  expect(await Bun.file(path.join(dir, 'one.txt')).text()).toBe('one\n')
}, 30_000)

it('gives a task back to this machine when its worker dies under it', async () => {
  // On the worker the command kills it (its shell's parent); given back,
  // it runs here, where the marker it left says not to.
  const dir = await pkg(
    'a',
    `export default { tasks: { hi: { exec: { command: 'if [ ! -e gone ]; then touch gone; kill -9 $PPID; sleep 5; fi; echo here > here.txt' } } } }`,
  )
  await workspace(1)
  const r = await run({ cwd: root, tasks: ['hi'], log: quiet(), handleSignals: false })
  expect(r.outcomes.map((o) => [o.node.id, o.status, o.placement?.where])).toEqual([
    ['a#hi', 'success', undefined],
  ])
  expect(await Bun.file(path.join(dir, 'gone')).exists()).toBe(true)
  expect(await Bun.file(path.join(dir, 'here.txt')).text()).toBe('here\n')
}, 30_000)
