import { createMemo, createResource } from 'solid-js'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getOriginSignal,
  getStorageGrowth,
  listCacheEntries,
} from '../api.ts'
import { C, S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { paletteFor } from '../format.ts'

const enc = encodeURIComponent

const SPEC = toSpec(
  el('Page', { title: 'Cache' }, [
    el('Grid', { variant: 'metrics-4' }, [
      el('Metric', { label: 'Entries', value: C('fmtNumber', { n: S('/entryCount') }) }),
      el('Metric', { label: 'Total size', value: C('fmtBytes', { b: S('/totalBytes') }) }),
      el('Metric', { label: 'Hit rate (24h)', value: C('fmtPercent0', { n: S('/hitRate24h') }), sub: S('/hitsSub') }),
      el('Metric', { label: 'Time saved (all-time)', value: C('fmtDuration', { ms: S('/savedMs') }), tone: 'good' }),
    ], { visible: { $state: '/loaded', eq: true } }),

    el('Grid', { variant: 'main-320' }, [
      el('Card', { title: 'Storage by project' }, [
        el('Treemap', { data: S('/treemap'), height: 240, valueFormat: 'bytes' }, undefined, { visible: { $state: '/hasTreemap', eq: true } }),
        el('Empty', { title: 'No cached output yet' }, undefined, { visible: { $state: '/hasTreemap', eq: false } }),
      ]),
      el('Card', { title: 'By project', noPad: true }, [
        el('RankList', {
          items: S('/breakdown'),
          labelKey: 'project',
          valueKey: 'totalBytes',
          valueFormat: 'bytes',
          metaKey: 'entries',
          metaSuffix: '×',
          dotsKeys: ['_color'],
          emptyTitle: 'No data',
        }),
      ]),
    ]),

    el('Card', { title: 'Storage growth (last 30 days)' }, [
      el('LineChart', {
        xs: S('/storageXs'),
        series: [{ name: 'bytes added', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: S('/storageData') }],
        xFormat: 'date',
        yFormat: 'bytes',
        height: 240,
      }, undefined, { visible: { $state: '/hasStorage', eq: true } }),
      el('Empty', { title: 'No data' }, undefined, { visible: { $state: '/hasStorage', eq: false } }),
    ]),

    el('Card', { title: 'Entries', noPad: true }, [
      el('DataTable', {
        rows: S('/entries'),
        rowHrefKey: '_href',
        filter: true,
        filterKey: '_filter',
        filterPlaceholder: 'filter by task or hash…',
        initialSort: { key: 'sizeBytes', desc: true },
        emptyTitle: 'No matching entries',
        columns: [
          { key: 'task', label: 'Task', kind: 'projtask' },
          { key: '_hash', label: 'Hash', kind: 'muted' },
          { key: 'sizeBytes', label: 'Size', align: 'right', kind: 'bytes', sortable: true },
          { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration', sortable: true },
          { key: 'createdAt', label: 'Created', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
          { key: 'accessedAt', label: 'Accessed', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
        ],
      }),
    ]),
  ]),
)

export function CachePage() {
  const origin = getOriginSignal()
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [breakdown] = createResource(origin, () => getCacheBreakdown(100))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [entries] = createResource(origin, () => listCacheEntries({ limit: 200, orderBy: 'size_bytes' }))

  const state = createMemo<Record<string, unknown>>(() => {
    const bd = breakdown() ?? []
    const sg = storage() ?? []
    const maxBytes = Math.max(1, ...bd.map((p) => p.totalBytes))
    const st = stats()
    return {
      loaded: !!(st && savings()),
      entryCount: st?.entryCount ?? 0,
      totalBytes: st?.totalBytes ?? 0,
      hitRate24h: st?.hitRate24h ?? 0,
      hitsSub: `${st?.hitCountLast24h ?? 0} hits`,
      savedMs: savings()?.estimatedTimeSavedTotalMs ?? 0,
      hasTreemap: bd.some((p) => p.totalBytes > 0),
      treemap: bd.map((p) => ({ label: p.project, value: p.totalBytes, colorClass: `fill-${paletteFor(p.project)}` })),
      breakdown: bd.map((p) => ({ ...p, _frac: p.totalBytes / maxBytes, _color: paletteFor(p.project) })),
      hasStorage: sg.length > 0,
      storageXs: sg.map((p) => p.t),
      storageData: sg.map((p) => p.bytesAdded),
      entries: (entries() ?? []).map((e) => ({
        ...e,
        _hash: `${e.hash.slice(0, 12)}…`,
        _href: `/tasks/${enc(`${e.project}#${e.task}`)}`,
        _filter: `${e.project}#${e.task} ${e.hash}`.toLowerCase(),
      })),
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
