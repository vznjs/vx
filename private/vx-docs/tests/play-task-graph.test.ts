// The task graph widget's model (src/components/play/model/task-graph.ts):
// the story workspace's order and reruns, as vx decides them.

import { describe, expect, it } from 'bun:test'
import {
  EDITS,
  NARROW,
  STORY,
  WIDE,
  allOf,
  downstream,
  matches,
  orderView,
  reruns,
  rerunView,
  storyGraph,
  waves,
} from '../src/components/play/model/task-graph.js'

const graph = storyGraph()

describe('the story graph', () => {
  it('resolves ^build to the build of each project the task depends on', () => {
    expect(graph.tasks.get('@demo/web#build')!.deps).toEqual(['@demo/ui#build'])
    expect(graph.tasks.get('@demo/web#test')!.deps).toEqual(['@demo/ui#build'])
    expect(graph.tasks.get('@demo/admin#build')!.deps).toEqual(['@demo/ui#build'])
    expect(graph.tasks.get('@demo/api#build')!.deps).toEqual([])
    expect(graph.tasks.get('@demo/ui#test')!.deps).toEqual([])
    expect(graph.tasks.size).toBe(12)
  })
})

describe('waves', () => {
  it('runs what a task waits on first, and nothing it does not need', () => {
    expect(waves(graph, ['@demo/web#build'])).toEqual([['@demo/ui#build'], ['@demo/web#build']])
    expect(waves(graph, ['@demo/api#build'])).toEqual([['@demo/api#build']])
  })

  it('puts tasks that wait on nothing in one wave, side by side', () => {
    expect(waves(graph, allOf('build'))).toEqual([
      ['@demo/api#build', '@demo/ui#build'],
      ['@demo/admin#build', '@demo/web#build'],
    ])
    // test --all pulls in @demo/ui#build: @demo/web#test and @demo/admin#test
    // wait on it, and the ^build of @demo/ui#test and @demo/api#test finds
    // no project to wait on.
    expect(waves(graph, allOf('test'))).toEqual([
      ['@demo/api#test', '@demo/ui#build', '@demo/ui#test'],
      ['@demo/admin#test', '@demo/web#test'],
    ])
  })

  it('says the order in one sentence', () => {
    expect(orderView(graph, ['@demo/web#build']).sentence).toBe(
      'vx runs @demo/ui#build first, then @demo/web#build.',
    )
    expect(orderView(graph, allOf('lint')).sentence).toBe(
      'vx runs @demo/admin#lint, @demo/api#lint, @demo/ui#lint and @demo/web#lint together. None waits on another.',
    )
  })

  it('shows the dependsOn line behind the edge', () => {
    const lines = orderView(graph, ['@demo/web#build']).lines
    expect(lines[0]!.text).toBe('// packages/web/vx.config.ts')
    expect(lines.find((l) => l.tone === 'accent')!.text).toContain("dependsOn: ['^build']")
    expect(orderView(graph, ['@demo/ui#test']).lines[2]!.text).toContain('→ nothing')
  })
})

describe('reruns', () => {
  it('misses the tasks that read the file and everything that waits on them', () => {
    expect(reruns(graph, 'packages/ui/src/index.ts')).toEqual({
      edited: ['@demo/ui#build', '@demo/ui#test', '@demo/ui#lint'],
      cascade: ['@demo/admin#build', '@demo/admin#test', '@demo/web#build', '@demo/web#test'],
      upToDate: [
        '@demo/web#lint',
        '@demo/admin#lint',
        '@demo/api#build',
        '@demo/api#test',
        '@demo/api#lint',
      ],
    })
  })

  it('misses only the tasks that read the file, then cascades from them', () => {
    // Only @demo/ui#build reads vite.config.ts; its test and lint keep their keys.
    expect(reruns(graph, 'packages/ui/vite.config.ts')).toEqual({
      edited: ['@demo/ui#build'],
      cascade: ['@demo/admin#build', '@demo/admin#test', '@demo/web#build', '@demo/web#test'],
      upToDate: [
        '@demo/ui#test',
        '@demo/ui#lint',
        '@demo/web#lint',
        '@demo/admin#lint',
        '@demo/api#build',
        '@demo/api#test',
        '@demo/api#lint',
      ],
    })
  })

  it('does not cascade from a task nothing waits on', () => {
    const r = reruns(graph, 'packages/api/src/index.ts')
    expect(r.edited).toEqual(['@demo/api#build', '@demo/api#test', '@demo/api#lint'])
    expect(r.cascade).toEqual([])
  })

  it('never reaches upstream or another project', () => {
    const r = reruns(graph, 'packages/web/src/index.ts')
    expect(r.edited).toEqual(['@demo/web#build', '@demo/web#test', '@demo/web#lint'])
    expect(r.cascade).toEqual([])
    expect(r.upToDate).toContain('@demo/ui#build')
    expect(r.upToDate).toContain('@demo/admin#build')
  })

  it('leaves every task up to date when no task reads the file', () => {
    const v = rerunView(graph, 'packages/ui/README.md')
    expect([...v.boxes.values()].every((b) => b.tone === 'ok')).toBe(true)
    expect(v.sentence).toBe('No task reads packages/ui/README.md. All 12 stay up to date.')
  })

  it('names the key the cascade comes through', () => {
    expect(rerunView(graph, 'packages/ui/src/index.ts').sentence).toContain(
      "@demo/admin#build, @demo/admin#test, @demo/web#build and @demo/web#test rerun too: their keys include @demo/ui#build's key.",
    )
  })

  it('finds a reader for every edit chip but the README', () => {
    for (const f of EDITS) expect(reruns(graph, f).edited.length > 0).toBe(!f.endsWith('README.md'))
  })

  it('reads globs as inputs.files does', () => {
    expect(matches('src/**', 'src/a/b.ts')).toBe(true)
    expect(matches('*.ts', 'a/b.ts')).toBe(false)
    expect(matches('index.html', 'index.html')).toBe(true)
    expect(downstream(graph, ['@demo/ui#build'])).toEqual(
      new Set(['@demo/web#build', '@demo/web#test', '@demo/admin#build', '@demo/admin#test']),
    )
  })
})

describe('the drawing', () => {
  it('draws every task and edge in both layouts, the phone one at most 360 across', () => {
    for (const l of [WIDE, NARROW]) {
      expect(l.boxes.map((b) => b.id).sort()).toEqual(STORY.map((s) => s.id).sort())
      expect(l.arrows).toHaveLength(4)
      for (const b of l.boxes) expect(b.x + b.w!).toBeLessThanOrEqual(l.width!)
      for (const f of l.frames!) expect(f.x + f.w).toBeLessThanOrEqual(l.width!)
    }
    expect(NARROW.width).toBeLessThanOrEqual(360)
  })

  it('draws no arrow through a box it does not join', () => {
    for (const l of [WIDE, NARROW]) {
      const at = (id: string) => l.boxes.find((b) => b.id === id)!
      const mid = (id: string) => [at(id).x + at(id).w! / 2, at(id).y + 30] as const
      for (const a of l.arrows!) {
        const [[x0, y0], [x1, y1]] = [mid(a.from), mid(a.to)]
        for (let i = 1; i < 50; i++) {
          const [x, y] = [x0 + ((x1 - x0) * i) / 50, y0 + ((y1 - y0) * i) / 50]
          const inside = l.boxes.filter((b) => x > b.x && x < b.x + b.w! && y > b.y && y < b.y + 60)
          for (const b of inside) expect([a.from, a.to]).toContain(b.id)
        }
      }
    }
  })
})
