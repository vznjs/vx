// A ready task's key is taken while it waits for a slot (`prepareKey`), so a
// task running in that slot may write its input before its command starts.
// The key then names bytes the command never read: the save is withheld, and
// restoring the old bytes runs the task again instead of replaying the new.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

let root: string
let status: string[]
const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-prepared-' })
  status = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('an input written while its task waited for a slot keeps the entry from its key', async () => {
  // `w#write` ranks first (`w#after` waits on it), holds the one slot, and
  // writes b's input once b's key is taken.
  await addProject(root, 'w', {
    config: `export default { tasks: {
      write: { exec: { command: 'sleep 0.5 && printf new > ../b/src/in.txt' } },
      after: { exec: { command: 'true' }, dependsOn: ['write'] },
    } }\n`,
  })
  const b = await addProject(root, 'b', {
    config: `export default { tasks: {
      build: {
        exec: { command: 'cat src/in.txt > out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
      },
    } }\n`,
    files: { 'src/in.txt': 'old' },
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')

  const first = await run({
    cwd: root,
    tasks: ['write', 'after', 'build'],
    concurrency: 1,
    log: logger,
  })
  expect(first.ok).toBe(true)
  expect(first.outcomes[0]?.node.id).toBe('w#write')
  expect(await readFile(path.join(b, 'out.txt'), 'utf8')).toBe('new')
  expect(status.some((l) => l.includes('b#build') && l.includes('changed after'))).toBe(true)

  gitIn(root)('checkout', '--', 'packages/b/src/in.txt')
  await rm(path.join(b, 'out.txt'))
  const again = await run({ cwd: root, tasks: ['build'], concurrency: 1, log: logger })
  expect(again.outcomes.find((o) => o.node.id === 'b#build')?.status).toBe('success')
  expect(await readFile(path.join(b, 'out.txt'), 'utf8')).toBe('old')
}, 30_000)

it('a task that waited for its slot restores the hit its lookup found while it waited', async () => {
  // b#gen (uncached, may write b) leaves b#build's key unstable, so no up-front
  // probe answers it; once b#gen ends, w#slow outranks b#build for the one slot.
  await addProject(root, 'w', {
    config: `export default { tasks: {
      slow: { exec: { command: 'sleep 0.3' }, dependsOn: ['b#gen'] },
      after: { exec: { command: 'true' }, dependsOn: ['slow'] },
    } }\n`,
  })
  const b = await addProject(root, 'b', {
    config: `export default { tasks: {
      gen: { exec: { command: 'true' }, inputs: { files: ['src/**'] } },
      build: {
        exec: { command: 'cat src/in.txt > out.txt' }, dependsOn: ['gen'],
        inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
      },
    } }\n`,
    files: { 'src/in.txt': 'old' },
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const tasks = ['gen', 'slow', 'after', 'build']
  expect((await run({ cwd: root, tasks, concurrency: 1, log: logger })).ok).toBe(true)
  await rm(path.join(b, 'out.txt'))
  const again = await run({ cwd: root, tasks, concurrency: 1, log: logger })
  expect(again.outcomes.map((o) => o.node.id).slice(0, 2)).toEqual(['b#gen', 'w#slow'])
  expect(again.outcomes.find((o) => o.node.id === 'b#build')?.status).toBe('cache-hit')
  expect(await readFile(path.join(b, 'out.txt'), 'utf8')).toBe('old')
}, 30_000)
