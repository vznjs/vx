import { Show, createMemo, createResource } from 'solid-js'
import { getBottlenecks, getFlakiest, getOriginSignal, getPrunable } from '../api.ts'
import { Card, type Column, DataTable, Grid, Page, Text } from '../jr/components.tsx'

const enc = encodeURIComponent

const INVEST_COLUMNS: Column[] = [
  { key: 'task', label: 'Task', kind: 'projtask', nKey: '_n' },
  { key: '_perDay', label: 'Runs / day', align: 'right' },
  { key: 'avgDurationMs', label: 'Avg', align: 'right', kind: 'duration' },
  { key: 'totalDurationMs', label: 'Total burn', align: 'right', kind: 'duration' },
  { key: 'weeklySavingsAt25PctCutMs', label: 'Weekly savings', align: 'right', kind: 'bar', format: 'duration' },
]
const FLAKY_COLUMNS: Column[] = [
  { key: 'task', label: 'Task', kind: 'projtask' },
  { key: 'failureRate', label: 'Fail %', align: 'right', kind: 'percent0', tone: { gt: 0.1, tone: 'danger' } },
  { key: 'durationTailRatio', label: 'p99/p50', align: 'right', kind: 'multiplier', tone: { gt: 3, tone: 'warn' } },
]
const PRUNE_COLUMNS: Column[] = [
  { key: 'task', label: 'Task', kind: 'projtask' },
  { key: 'sizeBytes', label: 'Size', align: 'right', kind: 'bytes' },
  { key: 'accessedAt', label: 'Last hit', align: 'right', kind: 'relativeTime', baseTone: 'faint' },
]

export function Bottlenecks() {
  const origin = getOriginSignal()
  const [bottlenecks] = createResource(origin, () => getBottlenecks(14, 25))
  const [flaky] = createResource(origin, () => getFlakiest(25))
  const [prunable] = createResource(origin, () => getPrunable(7, 25))

  const investRows = createMemo(() => {
    const bn = bottlenecks() ?? []
    const max = Math.max(1, ...bn.map((x) => x.weeklySavingsAt25PctCutMs))
    return bn.map((b, i) => ({ ...b, _n: i + 1, _perDay: b.runsPerDay.toFixed(1), _frac: b.weeklySavingsAt25PctCutMs / max, _color: 'success', _href: `/tasks/${enc(b.id)}` }))
  })
  const flakyRows = createMemo(() => (flaky() ?? []).map((f) => ({ ...f, _href: `/tasks/${enc(f.id)}` })))

  return (
    <Page title="Bottlenecks" subtitle="High-leverage targets — ranked by where you'd save the most time.">
      <Card title="Where to invest" actionText="14-day lookback · savings = 25% cut, weekly" noPad>
        <DataTable
          rows={investRows()}
          columns={INVEST_COLUMNS}
          rowHrefKey="_href"
          emptyTitle="Not enough runs to rank bottlenecks"
          emptyHint="Run a few tasks and come back."
        />
      </Card>

      <Grid variant="cols-2">
        <Card title="Flaky tasks" actionText="failure rate + tail ratio" noPad>
          <DataTable rows={flakyRows()} columns={FLAKY_COLUMNS} rowHrefKey="_href" emptyTitle="No flaky tasks 🎉" />
        </Card>
        <Card title="Prunable cache entries" actionText="unused ≥7d" noPad>
          <DataTable rows={prunable() ?? []} columns={PRUNE_COLUMNS} emptyTitle="Everything's been accessed recently" />
          <Show when={(prunable() ?? []).length > 0}>
            <Text text="Tip: vx cache prune --older-than 7d" tone="faint" mono class="px-4 py-2 border-t border-border" />
          </Show>
        </Card>
      </Grid>
    </Page>
  )
}
