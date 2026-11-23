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
    expect(graph.tasks.get('@demo/docs#build')!.deps).toEqual([])
    expect(graph.tasks.get('@demo/ui#test')!.deps).toEqual([])
    expect(graph.tasks.size).toBe(7)
  })
})

describe('waves', () => {
  it('runs what a task waits on first, and nothing it does not need', () => {
    expect(waves(graph, ['@demo/web#build'])).toEqual([['@demo/ui#build'], ['@demo/web#build']])
    expect(waves(graph, ['@demo/docs#build'])).toEqual([['@demo/docs#build']])
  })

  it('puts tasks that wait on nothing in one wave, side by side', () => {
    expect(waves(graph, allOf('build'))).toEqual([
      ['@demo/docs#build', '@demo/ui#build'],
      ['@demo/web#build'],
    ])
    // test --all pulls in @demo/ui#build: @demo/web#test waits on it, and
    // @demo/ui#test's ^build finds no project to wait on.
    expect(waves(graph, allOf('test'))).toEqual([
      ['@demo/ui#build', '@demo/ui#test'],
      ['@demo/web#test'],
    ])
  })

  it('says the order in one sentence', () => {
    expect(orderView(graph, ['@demo/web#build']).sentence).toBe(
      'vx runs @demo/ui#build first, then @demo/web#build.',
    )
    expect(orderView(graph, allOf('lint')).sentence).toBe(
      'vx runs @demo/ui#lint and @demo/web#lint together. None waits on another.',
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
    expect(reruns(graph, 'packages/ui/src/Button.tsx')).toEqual({
      edited: ['@demo/ui#build', '@demo/ui#test', '@demo/ui#lint'],
      cascade: ['@demo/web#build', '@demo/web#test'],
      upToDate: ['@demo/web#lint', '@demo/docs#build'],
    })
  })

  it('misses only the tasks that read the file, then cascades from them', () => {
    // Only @demo/ui#build reads vite.config.ts; its test and lint keep their keys.
    expect(reruns(graph, 'packages/ui/vite.config.ts')).toEqual({
      edited: ['@demo/ui#build'],
      cascade: ['@demo/web#build', '@demo/web#test'],
      upToDate: ['@demo/ui#test', '@demo/ui#lint', '@demo/web#lint', '@demo/docs#build'],
    })
  })

  it('does not cascade from a task nothing waits on', () => {
    const r = reruns(graph, 'packages/docs/src/main.ts')
    expect(r.edited).toEqual(['@demo/docs#build'])
    expect(r.cascade).toEqual([])
  })

  it('never reaches upstream or another project', () => {
    const r = reruns(graph, 'packages/web/src/App.tsx')
    expect(r.edited).toEqual(['@demo/web#build', '@demo/web#test', '@demo/web#lint'])
    expect(r.cascade).toEqual([])
    expect(r.upToDate).toContain('@demo/ui#build')
  })

  it('leaves every task up to date when no task reads the file', () => {
    const v = rerunView(graph, 'packages/ui/README.md')
    expect([...v.boxes.values()].every((b) => b.tone === 'ok')).toBe(true)
    expect(v.sentence).toBe('No task reads packages/ui/README.md. All 7 stay up to date.')
  })

  it('names the key the cascade comes through', () => {
    expect(rerunView(graph, 'packages/ui/src/Button.tsx').sentence).toContain(
      "@demo/web#build and @demo/web#test rerun too: their keys include @demo/ui#build's key.",
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
      new Set(['@demo/web#build', '@demo/web#test']),
    )
  })
})

describe('the drawing', () => {
  it('draws every task and edge in both layouts, the phone one at most 360 across', () => {
    for (const l of [WIDE, NARROW]) {
      expect(l.boxes.map((b) => b.id).sort()).toEqual(STORY.map((s) => s.id).sort())
      expect(l.arrows).toHaveLength(2)
    }
    expect(NARROW.width).toBeLessThanOrEqual(360)
    for (const b of NARROW.boxes) expect(b.x + b.w!).toBeLessThanOrEqual(NARROW.width!)
  })
})
