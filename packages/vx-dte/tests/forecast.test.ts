import { expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import { likelyMisses } from '../src/forecast.js'

const node = (id: string, dir: string, over: Record<string, unknown> = {}, deps: string[] = []) =>
  [
    id,
    {
      id,
      projectDir: `/w/${dir}`,
      deps,
      config: { exec: { command: 'x' }, cache: {}, inputs: { files: ['src/**'] }, ...over },
    } as unknown as TaskNode,
  ] as const

const nodes = new Map([
  node('a#build', 'a'),
  node('a#lint', 'a', { inputs: { files: ['src/**', '!src/gen/**'] } }),
  node('b#test', 'b', {}, ['a#build']),
  node('c#test', 'c', { inputs: { files: ['tests'], workspaceFiles: ['tsconfig.base.json'] } }),
  node('c#gate', 'c', { cache: undefined }),
])

it('names the cached tasks a change keys, and every one after them', () => {
  expect([...likelyMisses(nodes, ['a/src/x.ts'], '/w')].sort()).toEqual([
    'a#build',
    'a#lint',
    'b#test',
  ])
})

it('reads literals as trees, root-anchored inputs from the root, a project file as all of it', () => {
  expect([...likelyMisses(nodes, ['c/tests/x.ts'], '/w')]).toEqual(['c#test'])
  expect([...likelyMisses(nodes, ['tsconfig.base.json'], '/w')]).toEqual(['c#test'])
  expect([...likelyMisses(nodes, ['b/package.json'], '/w')]).toEqual(['b#test'])
  expect([...likelyMisses(nodes, ['b/README.md', 'c/docs/x.md'], '/w')]).toEqual([])
})

it('takes a lockfile or the workspace config as every cached task', () => {
  expect(likelyMisses(nodes, ['bun.lock'], '/w').size).toBe(4)
  expect(likelyMisses(nodes, ['.vx/workspace.ts'], '/w').size).toBe(4)
})
