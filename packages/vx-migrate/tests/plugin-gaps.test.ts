// One gap shared by several tasks is one line counting them: it read
// `2 task(s) (dev across 1 package(s))`.
import { expect, it } from 'bun:test'
import { collectGaps, warnGaps } from '../src/plugin-gaps.js'

const said = (projects: { name: string; tasks: { name: string; todos: string[] }[] }[]) => {
  const lines: string[] = []
  warnGaps((l) => lines.push(l), '@vzn/vx-migrate', collectGaps(projects, []), true)
  return lines
}

it('counts the tasks and packages of a shared gap in plain plurals', () => {
  expect(
    said([
      {
        name: 'a',
        tasks: [
          { name: 'dev', todos: ['gap'] },
          { name: 'watch', todos: ['gap'] },
        ],
      },
    ]),
  ).toEqual(['[@vzn/vx-migrate] 2 tasks (dev, watch across 1 package): gap'])
  expect(
    said([
      { name: 'a', tasks: [{ name: 'dev', todos: ['gap'] }] },
      { name: 'b', tasks: [{ name: 'dev', todos: ['gap'] }] },
    ]),
  ).toEqual(['[@vzn/vx-migrate] 2 tasks (dev across 2 packages): gap'])
})
