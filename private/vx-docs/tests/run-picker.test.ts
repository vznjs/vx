// The Running tasks page's picker against the plans real vx printed for
// the same four-project shop (`vx run … --dry`, 2026-11-23): a widget that
// drew a different plan from vx's would teach the wrong selection.

import { describe, expect, it } from 'bun:test'
import { command, filterProjects, plan } from '../src/components/demos/model/run-picker.ts'

const ids = (p: ReturnType<typeof plan>) => p.tasks.map((t) => t.id)

describe('run picker', () => {
  it('runs the cwd project and the builds it waits on', () => {
    const p = plan('build', { kind: 'here', project: '@shop/web' })
    expect(p.tasks).toEqual([
      { id: '@shop/ui#build', role: 'first' },
      { id: '@shop/web#build', role: 'requested' },
    ])
  })

  it("'...@shop/ui' plans what vx planned", () => {
    expect(ids(plan('test', { kind: 'filter', filters: ['...@shop/ui'] }))).toEqual([
      '@shop/admin#test',
      '@shop/ui#build',
      '@shop/ui#test',
      '@shop/web#test',
    ])
  })

  it('--affected reaches users through ^build, and lint stays put', () => {
    const changed = { kind: 'affected', changed: ['@shop/ui', '@shop/api'] } as const
    expect(ids(plan('test', changed))).toEqual([
      '@shop/admin#test',
      '@shop/api#test',
      '@shop/ui#build',
      '@shop/ui#test',
      '@shop/web#test',
    ])
    expect(ids(plan('lint', changed))).toEqual(['@shop/api#lint', '@shop/ui#lint'])
  })

  it('reads every operator the page shows', () => {
    const of = (f: string) => {
      const r = filterProjects(f)
      return 'error' in r ? r.error : r.projects
    }
    expect(of('@shop/web...')).toEqual(['@shop/ui', '@shop/web'])
    expect(of('@shop/web^...')).toEqual(['@shop/ui'])
    expect(of('...^@shop/ui')).toEqual(['@shop/web', '@shop/admin'])
    expect(of('./packages/api')).toEqual(['@shop/api'])
    expect(of('web')).toEqual(['@shop/web'])
    expect(of('@shop/*')).toHaveLength(4)
    expect(of('@shop/wbe')).toBe('no projects matched filter(s): "@shop/wbe" · fix @shop/web')
  })

  it('an exclusion alone takes from every project', () => {
    expect(ids(plan('lint', { kind: 'filter', filters: ['!@shop/api'] }))).toEqual([
      '@shop/admin#lint',
      '@shop/ui#lint',
      '@shop/web#lint',
    ])
    expect(command('lint', { kind: 'filter', filters: ['!@shop/api'] })).toBe(
      "vx run lint --filter '!@shop/api'",
    )
  })
})
