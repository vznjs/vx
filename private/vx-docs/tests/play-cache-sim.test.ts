// CacheSim's model (src/components/play/model/cache-sim.ts): the story
// workspace's cache behaves as vx's does.

import { describe, expect, it } from 'bun:test'
import {
  deleteWebDist,
  emptyState,
  run,
  summary,
  terminalHtml,
  toggle,
  type RunResult,
  type State,
} from '../src/components/play/model/cache-sim.js'

const by = (r: RunResult) => Object.fromEntries(r.results.map((x) => [x.spec.id, x]))
const outcomes = (r: RunResult) => Object.fromEntries(r.results.map((x) => [x.spec.id, x.outcome]))

function warm(): State {
  const s = emptyState()
  run(s, 'build')
  run(s, 'test')
  run(s, 'build')
  return s
}

describe('first and second run', () => {
  it('misses everything on an empty cache, then is up to date', () => {
    const s = emptyState()
    const first = run(s, 'build')
    expect(Object.values(outcomes(first))).toEqual(['miss', 'miss', 'miss'])
    expect(first.results[0]!.verdict).toContain('first recorded run')
    const second = run(s, 'build')
    expect(Object.values(outcomes(second))).toEqual(['up-to-date', 'up-to-date', 'up-to-date'])
    expect(second.results[0]!.verdict).toBe(
      'cache key unchanged — this run was served from cache, nothing re-ran',
    )
  })
})

describe('what moves a key', () => {
  it('an input of ui misses ui and web, through the upstream key', () => {
    const s = warm()
    toggle(s, 'button')
    const r = by(run(s, 'build'))
    expect(r['@demo/ui#build']!.outcome).toBe('miss')
    expect(r['@demo/ui#build']!.verdict).toBe('cache key changed: file packages/ui/src/Button.tsx')
    expect(r['@demo/web#build']!.outcome).toBe('miss')
    expect(r['@demo/web#build']!.verdict).toBe('cache key changed: upstream @demo/ui#build')
    expect(r['@demo/docs#build']!.outcome).toBe('up-to-date')
  })

  it('an input of web misses web only', () => {
    const s = warm()
    toggle(s, 'app')
    expect(outcomes(run(s, 'build'))).toEqual({
      '@demo/ui#build': 'up-to-date',
      '@demo/docs#build': 'up-to-date',
      '@demo/web#build': 'miss',
    })
  })

  it('an undeclared file, a gitignored file and an undeclared env var move nothing', () => {
    for (const c of ['readme', 'ignored', 'envUndeclared'] as const) {
      const s = warm()
      toggle(s, c)
      const r = run(s, 'build')
      expect(r.results.every((x) => x.outcome === 'up-to-date' && x.key === x.previousKey)).toBe(
        true,
      )
      expect(r.quiet.map((q) => q.change.id)).toEqual([c])
      expect(summary(r)).toContain(c === 'envUndeclared' ? 'inputs.env' : 'packages/ui/')
    }
  })

  it('the evaluated config is in the key: a new command misses, and web follows', () => {
    const s = warm()
    toggle(s, 'command')
    const r = run(s, 'build')
    expect(by(r)['@demo/ui#build']!.verdict).toBe('cache key changed: config')
    expect(by(r)['@demo/web#build']!.outcome).toBe('miss')
    expect(terminalHtml(r)).toContain('$ vite build --minify false')
  })

  it('a declared env var misses the task that lists it', () => {
    const s = warm()
    toggle(s, 'envDeclared')
    const r = by(run(s, 'build'))
    expect(r['@demo/web#build']!.verdict).toBe('cache key changed: env VITE_API_URL')
    expect(r['@demo/ui#build']!.outcome).toBe('up-to-date')
  })

  it('names the first three moved parts, then a count', () => {
    const s = warm()
    toggle(s, 'app')
    toggle(s, 'envDeclared')
    toggle(s, 'button')
    toggle(s, 'command')
    expect(by(run(s, 'build'))['@demo/web#build']!.verdict).toBe(
      'cache key changed: file packages/web/src/App.tsx, env VITE_API_URL, upstream @demo/ui#build',
    )
  })

  it("test's ^build folds ui's build key: a ui edit misses web's tests too", () => {
    const s = warm()
    toggle(s, 'button')
    const r = run(s, 'test')
    expect(outcomes(r)).toEqual({
      '@demo/ui#build': 'miss',
      '@demo/ui#test': 'miss',
      '@demo/docs#test': 'up-to-date',
      '@demo/web#test': 'miss',
    })
    expect(by(r)['@demo/web#test']!.verdict).toBe('cache key changed: upstream @demo/ui#build')
  })

  it('a key never folds a task it does not depend on: lint has no dependsOn', () => {
    const s = warm()
    run(s, 'lint')
    toggle(s, 'button')
    expect(outcomes(run(s, 'lint'))).toEqual({
      '@demo/ui#lint': 'miss',
      '@demo/docs#lint': 'up-to-date',
      '@demo/web#lint': 'up-to-date',
    })
  })
})

describe('hits and outputs', () => {
  it('missing outputs under the same key are restored, not rerun', () => {
    const s = warm()
    deleteWebDist(s)
    const r = by(run(s, 'build'))
    expect(r['@demo/web#build']!.outcome).toBe('restored')
    expect(r['@demo/web#build']!.verdict).toContain('cache key unchanged')
    expect(by(run(s, 'build'))['@demo/web#build']!.outcome).toBe('up-to-date')
  })

  it('undoing an edit brings back a stored key: a hit that restores', () => {
    const s = warm()
    const before = by(run(s, 'build'))['@demo/ui#build']!.key
    toggle(s, 'button')
    run(s, 'build')
    toggle(s, 'button')
    const r = by(run(s, 'build'))
    expect(r['@demo/ui#build']!.key).toBe(before)
    expect(r['@demo/ui#build']!.outcome).toBe('restored')
    expect(r['@demo/web#build']!.outcome).toBe('restored')
    expect(r['@demo/ui#build']!.verdict).toBe('cache key changed: file packages/ui/src/Button.tsx')
  })

  it('a task with no outputs is up to date on any stored key', () => {
    const s = warm()
    toggle(s, 'button')
    run(s, 'test')
    toggle(s, 'button')
    expect(by(run(s, 'test'))['@demo/ui#test']!.outcome).toBe('up-to-date')
  })

  it('prints the words vx prints on the frame', () => {
    const s = warm()
    deleteWebDist(s)
    toggle(s, 'app')
    const html = terminalHtml(run(s, 'build'))
    expect(html).toContain('success')
    expect(html).toContain('up-to-date')
    deleteWebDist(s)
    expect(terminalHtml(run(s, 'build'))).toContain('restored-local')
  })
})
