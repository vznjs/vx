import { createMemo, createResource } from 'solid-js'
import {
  type BottleneckRow,
  type FlakyTask,
  type PrunableEntry,
  getBottlenecks,
  getFlakiest,
  getOriginSignal,
  getPrunable,
} from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

const enc = encodeURIComponent

interface Data {
  bottlenecks?: BottleneckRow[]
  flaky?: FlakyTask[]
  prunable?: PrunableEntry[]
}

function build(d: Data): Node {
  const bottlenecks = d.bottlenecks ?? []
  const flaky = d.flaky ?? []
  const prunable = d.prunable ?? []
  const maxSavings = Math.max(1, ...bottlenecks.map((x) => x.weeklySavingsAt25PctCutMs))

  const invest = el('Card', { title: 'Where to invest', actionText: '14-day lookback · savings = 25% cut, weekly', noPad: true }, [
    el('DataTable', {
      emptyTitle: 'Not enough runs to rank bottlenecks',
      emptyHint: 'Run a few tasks and come back.',
      columns: [
        { key: 'task', label: 'Task' },
        { key: 'perday', label: 'Runs / day', align: 'right' },
        { key: 'avg', label: 'Avg', align: 'right' },
        { key: 'burn', label: 'Total burn', align: 'right' },
        { key: 'savings', label: 'Weekly savings', align: 'right' },
      ],
      rows: bottlenecks.map((b, i) => ({
        href: `/tasks/${enc(b.id)}`,
        cells: {
          task: { kind: 'projtask', n: i + 1, project: b.project, task: b.task },
          perday: b.runsPerDay.toFixed(1),
          avg: formatDuration(b.avgDurationMs),
          burn: formatDuration(b.totalDurationMs),
          savings: { kind: 'bar', v: formatDuration(b.weeklySavingsAt25PctCutMs), fraction: b.weeklySavingsAt25PctCutMs / maxSavings, color: 'success' },
        },
      })),
    }),
  ])

  const flakyCard = el('Card', { title: 'Flaky tasks', actionText: 'failure rate + tail ratio', noPad: true }, [
    el('DataTable', {
      emptyTitle: 'No flaky tasks 🎉',
      columns: [
        { key: 'task', label: 'Task' },
        { key: 'fail', label: 'Fail %', align: 'right' },
        { key: 'tail', label: 'p99/p50', align: 'right' },
      ],
      rows: flaky.map((f) => ({
        href: `/tasks/${enc(f.id)}`,
        cells: {
          task: { kind: 'projtask', project: f.project, task: f.task },
          fail: { kind: 'tone', v: formatPercent(f.failureRate, 0), tone: f.failureRate > 0.1 ? 'danger' : 'default' },
          tail: { kind: 'tone', v: f.durationTailRatio !== undefined ? `${f.durationTailRatio.toFixed(1)}×` : '—', tone: (f.durationTailRatio ?? 0) > 3 ? 'warn' : 'default' },
        },
      })),
    }),
  ])

  const prunableCard = el('Card', { title: 'Prunable cache entries', actionText: 'unused ≥7d', noPad: true }, [
    el('DataTable', {
      emptyTitle: "Everything's been accessed recently",
      columns: [
        { key: 'task', label: 'Task' },
        { key: 'size', label: 'Size', align: 'right' },
        { key: 'last', label: 'Last hit', align: 'right' },
      ],
      rows: prunable.map((e) => ({
        cells: {
          task: { kind: 'projtask', project: e.project, task: e.task },
          size: formatBytes(e.sizeBytes),
          last: { kind: 'tone', v: formatRelativeTime(e.accessedAt), tone: 'faint' },
        },
      })),
    }),
    prunable.length > 0 && el('Text', { text: 'Tip: vx cache prune --older-than 7d', tone: 'faint', mono: true, class: 'px-4 py-2 border-t border-border' }),
  ])

  return el('Page', { title: 'Bottlenecks', subtitle: "High-leverage targets — ranked by where you'd save the most time." }, [
    invest,
    el('Grid', { variant: 'cols-2' }, [flakyCard, prunableCard]),
  ])
}

export function Bottlenecks() {
  const origin = getOriginSignal()
  const [bottlenecks] = createResource(origin, () => getBottlenecks(14, 25))
  const [flaky] = createResource(origin, () => getFlakiest(25))
  const [prunable] = createResource(origin, () => getPrunable(7, 25))
  const spec = createMemo(() => toSpec(build({ bottlenecks: bottlenecks(), flaky: flaky(), prunable: prunable() })))
  return <DashRenderer spec={spec()} />
}
