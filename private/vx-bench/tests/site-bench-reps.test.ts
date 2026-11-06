// One cold run per runner let a single slow or fast run move the site's
// cold figure by seconds (2026-11-01: 6.0 to 8.2 s between two main
// pushes with no runtime change). Each close row is the median of three.
// Nx's cold overhead is minutes (2m 54s on b6d75e2, vx's 6.76 s), so a
// few seconds of noise moves no comparison, and its two extra cold runs
// were ~10 of the Bench job's 37 min (2026-11-06).
import { expect, it } from 'bun:test'
import config from '../vx.config.ts'

type Task = { exec?: { env?: { define?: Record<string, string> } } }

it('times each close runner cold three times, Nx once', () => {
  const tasks = config.tasks as Record<string, Task>
  const reps = ['vx', 'turbo', 'nx', 'vite-task'].map(
    (r) => tasks[`bench.${r}`]?.exec?.env?.define?.['COLD_REPS'],
  )
  expect(reps).toEqual(['3', '3', '1', '3'])
})
