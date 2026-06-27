import type { JsonView } from '../jr/page.tsx'

export const CACHE: JsonView = {
  data: {
    stats: 'cacheStats',
    savings: 'cacheSavings',
    breakdown: 'cacheBreakdown',
    storage: 'storage',
    entries: 'cacheEntries',
  },
  spec: {
    type: 'Page',
    props: { title: 'Cache' },
    children: [
      {
        type: 'Grid',
        props: { variant: 'metrics-4' },
        visible: { $state: '/statsStatus', eq: 'ok' },
        children: [
          { type: 'Metric', props: { label: 'Entries', value: { $computed: 'fmtNumber', args: { n: { $state: '/stats/entryCount' } } } } },
          { type: 'Metric', props: { label: 'Total size', value: { $computed: 'fmtBytes', args: { b: { $state: '/stats/totalBytes' } } } } },
          {
            type: 'Metric',
            props: {
              label: 'Hit rate (24h)',
              value: { $computed: 'fmtPercent0', args: { n: { $state: '/stats/hitRate24h' } } },
              sub: { $computed: 'text', args: { tpl: '{n} hits', n: { $state: '/stats/hitCountLast24h' } } },
            },
          },
          {
            type: 'Metric',
            props: {
              label: 'Time saved (all-time)',
              value: { $computed: 'fmtDuration', args: { ms: { $state: '/savings/estimatedTimeSavedTotalMs' } } },
              tone: 'good',
            },
          },
        ],
      },
      {
        type: 'Grid',
        props: { variant: 'main-320' },
        children: [
          {
            type: 'Card',
            props: { title: 'Storage by project' },
            children: [{ type: 'Treemap', props: { rows: { $state: '/breakdown' }, labelKey: 'project', valueKey: 'totalBytes', valueFormat: 'bytes', height: 240 } }],
          },
          {
            type: 'Card',
            props: { title: 'By project', noPad: true },
            children: [
              {
                type: 'RankList',
                props: {
                  items: { $state: '/breakdown' },
                  labelKey: 'project',
                  valueKey: 'totalBytes',
                  valueFormat: 'bytes',
                  metaKey: 'entries',
                  metaSuffix: '×',
                  barFrom: 'totalBytes',
                  colorFrom: 'project',
                  dots: [{ field: 'project', map: 'palette' }],
                  emptyTitle: 'No data',
                },
              },
            ],
          },
        ],
      },
      {
        type: 'Card',
        props: { title: 'Storage growth (last 30 days)' },
        children: [
          {
            type: 'LineChart',
            props: {
              rows: { $state: '/storage' },
              xKey: 't',
              xFormat: 'date',
              yFormat: 'bytes',
              height: 240,
              series: [{ name: 'bytes added', yKey: 'bytesAdded', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10' }],
            },
          },
        ],
      },
      {
        type: 'Card',
        props: { title: 'Entries', noPad: true },
        children: [
          {
            type: 'DataTable',
            props: {
              rows: { $state: '/entries' },
              filter: true,
              filterFrom: ['project', 'task', 'hash'],
              filterPlaceholder: 'filter by task or hash…',
              initialSort: { key: 'sizeBytes', desc: true },
              rowTaskRef: {},
              emptyTitle: 'No matching entries',
              columns: [
                { key: 'task', label: 'Task', kind: 'projtask' },
                { key: 'hash', label: 'Hash', kind: 'shorthash', len: 12 },
                { key: 'sizeBytes', label: 'Size', align: 'right', kind: 'bytes', sortable: true },
                { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration', sortable: true },
                { key: 'createdAt', label: 'Created', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
                { key: 'accessedAt', label: 'Accessed', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
              ],
            },
          },
        ],
      },
    ],
  },
}
