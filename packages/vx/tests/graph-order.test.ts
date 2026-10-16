// The task graph and every key are the same whatever order the tasks are
// asked for in, or the projects filtered in (Nx: "should create
// deterministic task graphs regardless of target order").

import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { dry } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-graph-order-', edges: { a: ['b', 'c'], b: ['c'] } })
  for (const p of ['c', 'a', 'b']) {
    await addProject(root, p, {
      config: `export default { tasks: {
        test: { exec: { command: 'true' }, dependsOn: ['build'], inputs: { files: ['src/**'], tasks: ['build'] } },
        build: { exec: { command: 'true' }, dependsOn: ['^build'], inputs: { files: ['src/**'] } },
      } }`,
      files: { 'src/x': `${p}\n` },
    })
  }
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const graph = async (args: string[]) =>
  (await dry(root, args))
    .map((t) => ({ id: t.id, hash: t.hash, deps: [...t.deps].sort() }))
    .sort((x, y) => x.id.localeCompare(y.id))

it('the graph and its keys do not depend on the order tasks or filters are given in', async () => {
  const want = await graph(['build', 'test', '--all'])
  expect(want.map((t) => t.id)).toEqual([
    'a#build',
    'a#test',
    'b#build',
    'b#test',
    'c#build',
    'c#test',
  ])
  expect(want.find((t) => t.id === 'a#build')?.deps).toEqual(['b#build', 'c#build'])
  expect(await graph(['test', 'build', '--all'])).toEqual(want)
  expect(await graph(['test', 'build', '--filter', 'c', '--filter', 'a', '--filter', 'b'])).toEqual(
    want,
  )
})
