import { Show, createMemo, createResource } from 'solid-js'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getOriginSignal,
  getStorageGrowth,
  listCacheEntries,
} from '../api.ts'
import { Card, type Column, DataTable, Empty, Grid, LineChart, Metric, Page, RankList, Treemap } from '../jr/components.tsx'
import { formatBytes, formatDuration, formatPercent, paletteFor } from '../format.ts'

const enc = encodeURIComponent

const COLUMNS: Column[] = [
  { key: 'task', label: 'Task', kind: 'projtask' },
  { key: '_hash', label: 'Hash', kind: 'muted' },
  { key: 'sizeBytes', label: 'Size', align: 'right', kind: 'bytes', sortable: true },
  { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration', sortable: true },
  { key: 'createdAt', label: 'Created', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
  { key: 'accessedAt', label: 'Accessed', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
]

export function CachePage() {
  const origin = getOriginSignal()
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [breakdown] = createResource(origin, () => getCacheBreakdown(100))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [entries] = createResource(origin, () => listCacheEntries({ limit: 200, orderBy: 'size_bytes' }))

  const bd = () => breakdown() ?? []
  const sg = () => storage() ?? []
  const treemap = createMemo(() => bd().map((p) => ({ label: p.project, value: p.totalBytes, colorClass: `fill-${paletteFor(p.project)}` })))
  const byProject = createMemo(() => {
    const max = Math.max(1, ...bd().map((p) => p.totalBytes))
    return bd().map((p) => ({ ...p, _frac: p.totalBytes / max, _color: paletteFor(p.project) }))
  })
  const rows = createMemo(() =>
    (entries() ?? []).map((e) => ({
      ...e,
      _hash: `${e.hash.slice(0, 12)}…`,
      _href: `/tasks/${enc(`${e.project}#${e.task}`)}`,
      _filter: `${e.project}#${e.task} ${e.hash}`.toLowerCase(),
    })),
  )

  return (
    <Page title="Cache">
      <Show when={stats() && savings()}>
        <Grid variant="metrics-4">
          <Metric label="Entries" value={String(stats()!.entryCount)} />
          <Metric label="Total size" value={formatBytes(stats()!.totalBytes)} />
          <Metric label="Hit rate (24h)" value={formatPercent(stats()!.hitRate24h, 0)} sub={`${stats()!.hitCountLast24h} hits`} />
          <Metric label="Time saved (all-time)" value={formatDuration(savings()!.estimatedTimeSavedTotalMs)} tone="good" />
        </Grid>
      </Show>

      <Grid variant="main-320">
        <Card title="Storage by project">
          <Show when={treemap().length > 0} fallback={<Empty title="No cached output yet" />}>
            <Treemap data={treemap()} height={240} valueFormat="bytes" />
          </Show>
        </Card>
        <Card title="By project" noPad>
          <RankList items={byProject()} labelKey="project" valueKey="totalBytes" valueFormat="bytes" metaKey="entries" metaSuffix="×" dotsKeys={['_color']} emptyTitle="No data" />
        </Card>
      </Grid>

      <Card title="Storage growth (last 30 days)">
        <Show when={sg().length > 0} fallback={<Empty title="No data" />}>
          <LineChart
            xs={sg().map((p) => p.t)}
            series={[{ name: 'bytes added', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: sg().map((p) => p.bytesAdded) }]}
            xFormat="date"
            yFormat="bytes"
            height={240}
          />
        </Show>
      </Card>

      <Card title="Entries" noPad>
        <DataTable
          rows={rows()}
          columns={COLUMNS}
          rowHrefKey="_href"
          filter
          filterKey="_filter"
          filterPlaceholder="filter by task or hash…"
          initialSort={{ key: 'sizeBytes', desc: true }}
          emptyTitle="No matching entries"
        />
      </Card>
    </Page>
  )
}
