// One cold run per runner let a single slow or fast run move the site's
// cold figure by seconds (2026-11-01: 6.0 to 8.2 s between two main
// pushes with no runtime change). Each site row is the median of three.
import { expect, it } from 'bun:test'
import config from '../vx.config.ts'

type Task = { exec?: { env?: { define?: Record<string, string> } } }

it('times each site runner cold three times', () => {
  const tasks = config.tasks as Record<string, Task>
  const reps = ['vx', 'turbo', 'nx', 'vite-task'].map(
    (r) => tasks[`bench.${r}`]?.exec?.env?.define?.['COLD_REPS'],
  )
  expect(reps).toEqual(['3', '3', '3', '3'])
})
