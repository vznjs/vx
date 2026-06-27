import { createMemo, createResource } from 'solid-js'
import type { Spec } from '@json-render/solid'
import { getOriginSignal, listProjects } from '../api.ts'
import { Dash } from '../jr/renderer.tsx'

// The OTHER way to build UI with the catalog: a RAW JSON spec (flat element
// tree). The SAME components the JSX pages use are rendered here from data —
// props bind to `state` via $state / $computed. This is the path an AI (or a
// saved layout) would produce; the JSX pages are the hand-written equivalent.
const SPEC: Spec = {
  root: 'page',
  elements: {
    page: {
      type: 'Page',
      props: { title: 'Spec demo', subtitle: 'This page is rendered from raw JSON through the same catalog the JSX pages use.' },
      children: ['grid', 'card'],
    },
    grid: { type: 'Grid', props: { variant: 'metrics-4' }, children: ['m1', 'm2'] },
    m1: { type: 'Metric', props: { label: 'Projects', value: { $computed: 'fmtNumber', args: { n: { $state: '/count' } } } } },
    m2: { type: 'Metric', props: { label: 'Total time', value: { $computed: 'fmtDuration', args: { ms: { $state: '/totalMs' } } } } },
    card: { type: 'Card', props: { title: 'Projects', noPad: true }, children: ['table'] },
    table: {
      type: 'DataTable',
      props: {
        rows: { $state: '/rows' },
        rowHrefKey: '_href',
        columns: [
          { key: 'project', label: 'Project' },
          { key: 'runs', label: 'Runs', align: 'right' },
          { key: 'totalDurationMs', label: 'Total', align: 'right', kind: 'duration' },
        ],
      },
    },
  },
}

export function SpecDemo() {
  const origin = getOriginSignal()
  const [projects] = createResource(origin, () => listProjects(50))
  const state = createMemo<Record<string, unknown>>(() => {
    const ps = projects() ?? []
    return {
      count: ps.length,
      totalMs: ps.reduce((a, p) => a + p.totalDurationMs, 0),
      rows: ps.map((p) => ({ ...p, _href: `/projects/${encodeURIComponent(p.project)}` })),
    }
  })
  return <Dash spec={SPEC} state={state()} />
}
