// The Running tasks page's picker against the plans real vx printed for
// the same four-project demo workspace (`vx run … --dry`, 2026-11-23): a widget that
// drew a different plan from vx's would teach the wrong selection.

import { describe, expect, it } from 'bun:test'
import { command, filterProjects, plan } from '../src/components/demos/model/run-picker.ts'
import type { Scope } from '../src/components/demos/model/run-picker.ts'

const ids = (p: ReturnType<typeof plan>) => p.tasks.map((t) => t.id)

describe('run picker', () => {
  it('runs the cwd project and the builds it waits on', () => {
    const p = plan('build', { kind: 'here', project: '@demo/web' })
    expect(p.tasks).toEqual([
      { id: '@demo/ui#build', role: 'first' },
      { id: '@demo/web#build', role: 'requested' },
    ])
  })

  it("'...@demo/ui' plans what vx planned", () => {
    expect(ids(plan('test', { kind: 'filter', filters: ['...@demo/ui'] }))).toEqual([
      '@demo/admin#test',
      '@demo/ui#build',
      '@demo/ui#test',
      '@demo/web#test',
    ])
  })

  it('--affected reaches users through ^build, and lint stays put', () => {
    const changed: Scope = { kind: 'affected', changed: ['@demo/ui', '@demo/api'] }
    expect(ids(plan('test', changed))).toEqual([
      '@demo/admin#test',
      '@demo/api#test',
      '@demo/ui#build',
      '@demo/ui#test',
      '@demo/web#test',
    ])
    expect(ids(plan('lint', changed))).toEqual(['@demo/api#lint', '@demo/ui#lint'])
  })

  it('reads every operator the page shows', () => {
    const of = (f: string) => {
      const r = filterProjects(f)
      return 'error' in r ? r.error : r.projects
    }
    expect(of('@demo/web...')).toEqual(['@demo/ui', '@demo/web'])
    expect(of('@demo/web^...')).toEqual(['@demo/ui'])
    expect(of('...^@demo/ui')).toEqual(['@demo/web', '@demo/admin'])
    expect(of('./packages/api')).toEqual(['@demo/api'])
    expect(of('web')).toEqual(['@demo/web'])
    expect(of('@demo/*')).toHaveLength(4)
    expect(of('@demo/wbe')).toBe('no projects matched filter(s): "@demo/wbe" · fix @demo/web')
  })

  it('an exclusion alone takes from every project', () => {
    expect(ids(plan('lint', { kind: 'filter', filters: ['!@demo/api'] }))).toEqual([
      '@demo/admin#lint',
      '@demo/ui#lint',
      '@demo/web#lint',
    ])
    expect(command('lint', { kind: 'filter', filters: ['!@demo/api'] })).toBe(
      "vx run lint --filter '!@demo/api'",
    )
  })
})
