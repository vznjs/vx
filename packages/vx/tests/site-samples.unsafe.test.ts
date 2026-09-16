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
import { CACHE_LAYER_METHODS } from '../src/orchestrator/plugin-host.js'
import { ESSENTIAL_ENV } from '../src/exec/env.js'
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

describe('the plugins guide states the CacheLayer method count', () => {
  const WORDS = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ]
  it('"the N `CacheLayer` methods" is CACHE_LAYER_METHODS.length', () => {
    const page = readFileSync(path.join(GUIDES, 'plugins.md'), 'utf8')
    const m = /the ([a-z]+) `CacheLayer` methods/.exec(page)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(WORDS[CACHE_LAYER_METHODS.length])
  })
})

describe('the environment-variables guide names the essential allowlist', () => {
  it('its "always gets a small essential allowlist" sentence names every POSIX name in ESSENTIAL_ENV', () => {
    const page = readFileSync(path.join(GUIDES, 'environment-variables.md'), 'utf8')
    const m = /essential allowlist so normal CLI tools\s+work:([\s\S]*?)plus the Windows/.exec(page)
    expect(m).not.toBeNull()
    const named = new Set([...m![1]!.matchAll(/`([A-Z_]+)`/g)].map((x) => x[1]!))
    const posix = ESSENTIAL_ENV.slice(0, ESSENTIAL_ENV.indexOf('SYSTEMROOT'))
    expect(posix.length).toBeGreaterThan(10)
    for (const name of posix) expect(named).toContain(name)
  })
})
