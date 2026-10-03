// The admit stage's two warnings reach the user through the run's status
// line beside every other plugin warning, which says `[vx]` first; these
// two did not, so a line naming a plugin's failure read as the task's own
// output in a CI log.

import { expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { buildAdmission } from '../src/orchestrator/plugin-host.js'
import { testPlugin } from './helpers/plugin.js'

const nodes = new Map<string, TaskNode>([['a#t', { id: 'a#t' } as TaskNode]])

it('a refusal with nothing running is said with the [vx] prefix', () => {
  const said: string[] = []
  const admit = buildAdmission([testPlugin('org/never', { admit: () => false })], nodes, 1, (m) =>
    said.push(m),
  )!
  expect(admit('a#t', new Set())).toBe(true)
  expect(said).toEqual([
    "[vx] plugin 'org/never' refused a#t in admit with nothing running; admitting it, since no completion would ask again",
  ])
})

it('a throwing admit is said with the [vx] prefix', () => {
  const said: string[] = []
  const admit = buildAdmission(
    [
      testPlugin('org/boom', {
        admit: () => {
          throw new Error('boom')
        },
      }),
    ],
    nodes,
    1,
    (m) => said.push(m),
  )!
  expect(admit('a#t', new Set())).toBe(true)
  expect(said).toEqual([
    "[vx] plugin 'org/boom' failed in admit: boom; admitting every task from here on",
  ])
})
