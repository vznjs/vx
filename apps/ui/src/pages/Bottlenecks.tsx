import { createMemo, createResource } from 'solid-js'
import { getBottlenecks, getFlakiest, getOriginSignal, getPrunable } from '../api.ts'
import { S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'

const enc = encodeURIComponent

const SPEC = toSpec(
  el('Page', { title: 'Bottlenecks', subtitle: "High-leverage targets — ranked by where you'd save the most time." }, [
    el('Card', { title: 'Where to invest', actionText: '14-day lookback · savings = 25% cut, weekly', noPad: true }, [
      el('DataTable', {
        rows: S('/bottlenecks'),
        rowHrefKey: '_href',
        emptyTitle: 'Not enough runs to rank bottlenecks',
        emptyHint: 'Run a few tasks and come back.',
        columns: [
          { key: 'task', label: 'Task', kind: 'projtask', nKey: '_n' },
          { key: '_perDay', label: 'Runs / day', align: 'right' },
          { key: 'avgDurationMs', label: 'Avg', align: 'right', kind: 'duration' },
          { key: 'totalDurationMs', label: 'Total burn', align: 'right', kind: 'duration' },
          { key: 'weeklySavingsAt25PctCutMs', label: 'Weekly savings', align: 'right', kind: 'bar', format: 'duration' },
        ],
      }),
    ]),

    el('Grid', { variant: 'cols-2' }, [
      el('Card', { title: 'Flaky tasks', actionText: 'failure rate + tail ratio', noPad: true }, [
        el('DataTable', {
          rows: S('/flaky'),
          rowHrefKey: '_href',
          emptyTitle: 'No flaky tasks 🎉',
          columns: [
            { key: 'task', label: 'Task', kind: 'projtask' },
            { key: 'failureRate', label: 'Fail %', align: 'right', kind: 'percent0', tone: { gt: 0.1, tone: 'danger' } },
            { key: 'durationTailRatio', label: 'p99/p50', align: 'right', kind: 'multiplier', tone: { gt: 3, tone: 'warn' } },
          ],
        }),
      ]),
      el('Card', { title: 'Prunable cache entries', actionText: 'unused ≥7d', noPad: true }, [
        el('DataTable', {
          rows: S('/prunable'),
          emptyTitle: "Everything's been accessed recently",
          columns: [
            { key: 'task', label: 'Task', kind: 'projtask' },
            { key: 'sizeBytes', label: 'Size', align: 'right', kind: 'bytes' },
            { key: 'accessedAt', label: 'Last hit', align: 'right', kind: 'relativeTime', baseTone: 'faint' },
          ],
        }),
        el('Text', { text: 'Tip: vx cache prune --older-than 7d', tone: 'faint', mono: true, class: 'px-4 py-2 border-t border-border' }, undefined, {
          visible: { $state: '/hasPrunable', eq: true },
        }),
      ]),
    ]),
  ]),
)

export function Bottlenecks() {
  const origin = getOriginSignal()
  const [bottlenecks] = createResource(origin, () => getBottlenecks(14, 25))
  const [flaky] = createResource(origin, () => getFlakiest(25))
  const [prunable] = createResource(origin, () => getPrunable(7, 25))

  const state = createMemo<Record<string, unknown>>(() => {
    const bn = bottlenecks() ?? []
    const maxSavings = Math.max(1, ...bn.map((x) => x.weeklySavingsAt25PctCutMs))
    const pr = prunable() ?? []
    return {
      bottlenecks: bn.map((b, i) => ({
        ...b,
        _n: i + 1,
        _perDay: b.runsPerDay.toFixed(1),
        _frac: b.weeklySavingsAt25PctCutMs / maxSavings,
        _color: 'success',
        _href: `/tasks/${enc(b.id)}`,
      })),
      flaky: (flaky() ?? []).map((f) => ({ ...f, _href: `/tasks/${enc(f.id)}` })),
      prunable: pr,
      hasPrunable: pr.length > 0,
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
