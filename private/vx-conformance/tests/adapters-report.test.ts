import { expect, test } from 'bun:test'
import { viteTask } from '../src/adapters/vite-task.ts'

test('Vite Task’s last-run summary reads as a hit, with no time of its own', async () => {
  const out = `Task Details:
────────────────────────────────────────────────
  [1] a#build: ~/packages/a$ sleep 0.3 ✓
      → Cache hit - output replayed - 309ms saved
  [2] b#build: ~/packages/b$ sleep 0.3 ✓
      → Cache miss: no previous cache entry found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  expect(await viteTask.report('/', async () => out)).toEqual({
    'a#build': { cache: 'hit' },
    'b#build': { cache: 'miss' },
  })
})
