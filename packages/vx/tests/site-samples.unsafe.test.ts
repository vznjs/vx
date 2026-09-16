// The site's guides show terminal output "as it prints"; a sample nobody
// renders drifts (the formatter's own docblock showed a glyph it never
// wrote, item 302, 2026-09-16). Each sample here is rendered with the
// real formatter and compared byte for byte. The site
// lives outside packages/vx, which a sandboxed shard cannot read — hence
// the unsafe suite (the site's own tests reach only the public API).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { formatPlanText } from '../src/cli/plan-format.js'
import type { RunPlan } from '../src/orchestrator/plan.js'
import type { TaskNode } from '../src/graph/task-graph.js'

const GUIDES = path.resolve(
  import.meta.dir,
  '..',
  '..',
  'vx-docs',
  'src',
  'content',
  'docs',
  'guides',
)

function fencedBlock(page: string, lang: string, firstLine: string): string {
  const open = `\`\`\`${lang}\n${firstLine}`
  const start = page.indexOf(open)
  expect(start).toBeGreaterThan(-1)
  const body = start + lang.length + 4
  const end = page.indexOf('```', body)
  return page.slice(body, end)
}

describe('the running-tasks guide shows what --dry prints', () => {
  it('its `would run:` block is formatPlanText on three local hits', () => {
    const page = readFileSync(path.join(GUIDES, 'running-tasks.md'), 'utf8')
    const task = (id: string, hash: string) => ({
      node: {
        id,
        projectName: id.split('#')[0]!,
        taskName: id.split('#')[1]!,
        config: {},
      } as unknown as TaskNode,
      hash,
      cacheStatus: 'hit-local' as const,
      deps: [],
    })
    const plan: RunPlan = {
      tasks: [
        task('@acme/api#build', '8625b6031a2b3c4d'),
        task('@acme/ui#build', '71e5d9a05e6f7a8b'),
        task('@acme/web#build', '42e9b39d9c0d1e2f'),
      ],
    }
    expect(fencedBlock(page, 'text', 'would run:')).toBe(formatPlanText(plan))
  })
})
