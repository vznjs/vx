import { createMemo, createResource } from 'solid-js'
import {
  type CacheEntryRow,
  type CacheProjectRow,
  type CacheSavings,
  type CacheStats,
  type StoragePoint,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getOriginSignal,
  getStorageGrowth,
  listCacheEntries,
} from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

const enc = encodeURIComponent

interface Data {
  stats?: CacheStats
  savings?: CacheSavings
  breakdown?: CacheProjectRow[]
  storage?: StoragePoint[]
  entries?: CacheEntryRow[]
}

function build(d: Data): Node {
  const breakdown = d.breakdown ?? []
  const storage = d.storage ?? []
  const entries = d.entries ?? []
  const maxBytes = Math.max(1, ...breakdown.map((p) => p.totalBytes))

  const metrics =
    d.stats && d.savings
      ? el('Grid', { variant: 'metrics-4' }, [
          el('Metric', { label: 'Entries', value: String(d.stats.entryCount) }),
          el('Metric', { label: 'Total size', value: formatBytes(d.stats.totalBytes) }),
          el('Metric', { label: 'Hit rate (24h)', value: formatPercent(d.stats.hitRate24h, 0), sub: `${d.stats.hitCountLast24h} hits` }),
          el('Metric', { label: 'Time saved (all-time)', value: formatDuration(d.savings.estimatedTimeSavedTotalMs), tone: 'good' }),
        ])
      : undefined

  const treemapCard = el('Card', { title: 'Storage by project' }, [
    breakdown.some((p) => p.totalBytes > 0)
      ? el('Treemap', {
          data: breakdown.map((p) => ({ label: p.project, value: p.totalBytes, colorClass: `fill-${paletteFor(p.project)}` })),
          height: 240,
          valueFormat: 'bytes',
        })
      : el('Empty', { title: 'No cached output yet' }),
  ])

  const byProject = el('Card', { title: 'By project', noPad: true }, [
    el('RankList', {
      emptyTitle: 'No data',
      items: breakdown.map((p) => ({
        dots: [paletteFor(p.project)],
        label: p.project,
        metaRight: `${p.entries}×`,
        value: formatBytes(p.totalBytes),
        fraction: p.totalBytes / maxBytes,
        color: paletteFor(p.project),
      })),
    }),
  ])

  const growth = el('Card', { title: 'Storage growth (last 30 days)' }, [
    storage.length > 0
      ? el('LineChart', {
          xs: storage.map((p) => p.t),
          series: [{ name: 'bytes added', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: storage.map((p) => p.bytesAdded) }],
          xFormat: 'date',
          yFormat: 'bytes',
          height: 240,
        })
      : el('Empty', { title: 'No data' }),
  ])

  const entriesCard = el('Card', { title: 'Entries', noPad: true }, [
    el('DataTable', {
      filter: true,
      filterPlaceholder: 'filter by task or hash…',
      initialSort: { key: 'size', desc: true },
      emptyTitle: 'No matching entries',
      columns: [
        { key: 'task', label: 'Task' },
        { key: 'hash', label: 'Hash' },
        { key: 'size', label: 'Size', align: 'right', sortable: true },
        { key: 'duration', label: 'Duration', align: 'right', sortable: true },
        { key: 'created', label: 'Created', align: 'right', sortable: true },
        { key: 'accessed', label: 'Accessed', align: 'right', sortable: true },
      ],
      rows: entries.map((e) => ({
        href: `/tasks/${enc(`${e.project}#${e.task}`)}`,
        filter: `${e.project}#${e.task} ${e.hash}`.toLowerCase(),
        sort: { size: e.sizeBytes, duration: e.durationMs, created: e.createdAt, accessed: e.accessedAt },
        cells: {
          task: { kind: 'projtask', project: e.project, task: e.task },
          hash: { kind: 'muted', v: `${e.hash.slice(0, 12)}…` },
          size: formatBytes(e.sizeBytes),
          duration: formatDuration(e.durationMs),
          created: { kind: 'tone', v: formatRelativeTime(e.createdAt), tone: 'faint' },
          accessed: { kind: 'tone', v: formatRelativeTime(e.accessedAt), tone: 'faint' },
        },
      })),
    }),
  ])

  return el('Page', { title: 'Cache' }, [
    metrics,
    el('Grid', { variant: 'main-320' }, [treemapCard, byProject]),
    growth,
    entriesCard,
  ])
}

export function CachePage() {
  const origin = getOriginSignal()
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [breakdown] = createResource(origin, () => getCacheBreakdown(100))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [entries] = createResource(origin, () => listCacheEntries({ limit: 200, orderBy: 'size_bytes' }))
  const spec = createMemo(() =>
    toSpec(build({ stats: stats(), savings: savings(), breakdown: breakdown(), storage: storage(), entries: entries() })),
  )
  return <DashRenderer spec={spec()} />
}
