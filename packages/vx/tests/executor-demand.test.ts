// `executorDemand` driven directly: what each executor hears, and when.

import { expect, it } from 'bun:test'
import type { TaskExecutor } from '../src/exec/index.js'
import { executorDemand } from '../src/orchestrator/plugin-host.js'

function spy(): { executor: TaskExecutor; heard: string[][] } {
  const heard: string[][] = []
  const executor = {
    name: 'spy',
    demand: (remaining: ReadonlySet<string>) => heard.push([...remaining].sort()),
    execute: () => Promise.reject(new Error('not run')),
  } as unknown as TaskExecutor
  return { executor, heard }
}

it('tells nothing until settled, then the tasks the cache does not answer', () => {
  const { executor, heard } = spy()
  const d = executorDemand(new Map(['a', 'b', 'c'].map((id) => [id, executor])), () => {})
  d.finished('c')
  expect(heard).toEqual([])
  d.settle(['b', 'not-placed'])
  expect(heard).toEqual([['a']])
  d.settle(['a'])
  expect(heard).toEqual([['a']])
})

it('a hit that executes after all is demand again', () => {
  // Its artifact went missing between the probe and the restore: left out,
  // an executor that sizes by demand starts nothing for it and it waits.
  const { executor, heard } = spy()
  const d = executorDemand(new Map(['a', 'b'].map((id) => [id, executor])), () => {})
  d.settle(['b'])
  d.executing('b')
  d.executing('a')
  d.finished('b')
  expect(heard).toEqual([['a'], ['a', 'b'], ['a']])
})

it('a task that executes before the cache answers stays demand', () => {
  const { executor, heard } = spy()
  const d = executorDemand(new Map([['a', executor]]), () => {})
  d.executing('a')
  d.settle(['a'])
  expect(heard).toEqual([['a']])
})
