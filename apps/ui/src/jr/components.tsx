// The dashboard component catalog — ONE set of plain Solid components, usable
// two ways:
//   1. directly in JSX:        <Card noPad><DataTable rows={rows()} … /></Card>
//   2. via json-render specs:   <Dash spec={json} state={…} />  (renderer.tsx
//      adapts each of these to json-render's render context)
//
// They wrap the proven chart/ui primitives and add the rich self-contained
// widgets the dashboard needs (DataTable, RankList, LiveActivity). Tables/lists
// take RAW rows + a declarative column/item config and format internally, so a
// page only shapes data — never per-cell display objects.

import { For, Show, type JSX, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { A, useNavigate } from '@solidjs/router'
import { subscribeEvents } from '../api.ts'
import { HBar, Heatmap as HeatmapPrimitive, LineChart as LineChartPrimitive, Treemap as TreemapPrimitive } from '../components/charts.tsx'
import { Card as UiCard, EmptyState, MetricCard, StatusBadge } from '../components/ui.tsx'
import { Flamegraph as FlamegraphPrimitive } from '../components/Flamegraph.tsx'
import { formatHour } from '../format.ts'
import { type FormatHint, type Tone, axisFormatter, formatValue, toneText } from './hints.ts'

function Dot(props: { color: string }) {
  return <span class={`inline-block w-1.5 h-1.5 rounded-full bg-${props.color} shrink-0`} />
}

// --- Layout -----------------------------------------------------------------

export function Page(props: {
  title?: string
  subtitle?: string
  backHref?: string
  backLabel?: string
  dotColor?: string
  mono?: boolean
  children?: JSX.Element
}) {
  return (
    <div class="flex flex-col gap-5">
      <Show when={props.backHref}>
        <div class="flex items-center gap-3">
          <A href={props.backHref!} class="text-fg-3 hover:text-fg no-underline text-[11px] font-mono">
            ← {props.backLabel ?? 'back'}
          </A>
          <Show when={props.dotColor}>
            <span class={`inline-block w-2 h-2 rounded-full bg-${props.dotColor}`} />
          </Show>
          <h1 class={`text-base font-semibold m-0 ${props.mono ? 'font-mono' : ''}`}>{props.title}</h1>
        </div>
      </Show>
      <Show when={!props.backHref && (props.title || props.subtitle)}>
        <div>
          <Show when={props.title}>
            <h1 class="text-base font-semibold m-0">{props.title}</h1>
          </Show>
          <Show when={props.subtitle}>
            <p class="text-fg-3 text-[12px] mt-1 m-0">{props.subtitle}</p>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  )
}

const GRID: Record<string, string> = {
  'metrics-4': 'grid grid-cols-2 lg:grid-cols-4 gap-3',
  'metrics-5': 'grid grid-cols-2 lg:grid-cols-5 gap-3',
  'metrics-6': 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3',
  'cols-2': 'grid grid-cols-1 lg:grid-cols-2 gap-4',
  'cols-3': 'grid grid-cols-1 lg:grid-cols-3 gap-3',
  'main-280': 'grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4',
  'main-320': 'grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4',
}

export function Grid(props: { variant?: keyof typeof GRID; children?: JSX.Element }) {
  return <div class={GRID[props.variant ?? 'cols-2'] ?? GRID['cols-2']}>{props.children}</div>
}

const STACK: Record<string, string> = {
  '2': 'flex flex-col gap-2',
  '3': 'flex flex-col gap-3',
  '4': 'flex flex-col gap-4',
  '5': 'flex flex-col gap-5',
}

export function Stack(props: { gap?: '2' | '3' | '4' | '5'; children?: JSX.Element }) {
  return <div class={STACK[props.gap ?? '4']}>{props.children}</div>
}

// --- Content ----------------------------------------------------------------

export function Card(props: {
  title?: string
  actionText?: string
  actionHref?: string
  actionLabel?: string
  noPad?: boolean
  children?: JSX.Element
}) {
  const action = () =>
    props.actionHref ? (
      <A href={props.actionHref} class="text-[11px] text-accent no-underline hover:underline">
        {props.actionLabel ?? 'more'}
      </A>
    ) : props.actionText ? (
      <span class="text-[10px] text-fg-3 font-mono">{props.actionText}</span>
    ) : undefined
  return (
    <UiCard title={props.title} action={action()} noPad={props.noPad}>
      {props.children}
    </UiCard>
  )
}

export function Metric(props: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'good' | 'warn' | 'bad'
  delta?: number
}) {
  return <MetricCard label={props.label} value={props.value} sub={props.sub} tone={props.tone} delta={props.delta} />
}

export function Text(props: { text: string; tone?: Tone; mono?: boolean; class?: string }) {
  // Arbitrary sizes/weights come through `class` (a literal in page source that
  // UnoCSS can scan) — never interpolated here, which would emit invalid CSS.
  const cls = () => ['text-[12px]', toneText(props.tone), props.mono ? 'font-mono' : '', props.class ?? ''].filter(Boolean).join(' ')
  return <div class={cls()}>{props.text}</div>
}

export function Empty(props: { title: string; hint?: string; cmd?: string }) {
  return <EmptyState title={props.title} hint={props.hint} cmd={props.cmd} />
}

export function Facts(props: { items: Array<{ label: string; value: string; mono?: boolean }>; command?: string }) {
  return (
    <div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12px]">
        <For each={props.items}>
          {(it) => (
            <div class="flex gap-3 items-baseline">
              <span class="text-fg-3 text-[10px] uppercase tracking-wider w-20 shrink-0">{it.label}</span>
              <span class={it.mono ? 'font-mono text-fg-1' : ''}>{it.value}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.command}>
        <div class="mt-3 text-[11px] text-fg-3">
          $ <code class="text-fg-1 font-mono">{props.command}</code>
        </div>
      </Show>
    </div>
  )
}

// --- Charts -----------------------------------------------------------------

export interface SeriesSpec {
  name: string
  strokeClass: string
  areaClass?: string
  data: number[]
}

export function LineChart(props: {
  xs: number[]
  series: SeriesSpec[]
  xFormat?: FormatHint
  yFormat?: FormatHint
  height?: number
  yMin?: number
}) {
  return (
    <LineChartPrimitive
      xs={props.xs ?? []}
      series={props.series ?? []}
      formatX={axisFormatter(props.xFormat)}
      formatY={axisFormatter(props.yFormat)}
      height={props.height}
      yMin={props.yMin}
    />
  )
}

export function Treemap(props: {
  data: Array<{ label: string; value: number; colorClass?: string }>
  height?: number
  valueFormat?: FormatHint
}) {
  return <TreemapPrimitive data={props.data ?? []} height={props.height} format={(v) => formatValue(props.valueFormat, v)} />
}

export function Heatmap(props: {
  data: Array<{ dayOfWeek: number; hourOfDay: number; value: number }>
  cellSize?: number
  valueFormat?: FormatHint
}) {
  return (
    <HeatmapPrimitive
      data={props.data ?? []}
      cellSize={props.cellSize}
      format={(v) => (props.valueFormat ? formatValue(props.valueFormat, v) : `${v} runs`)}
    />
  )
}

export function Flamegraph(props: { tasks: Parameters<typeof FlamegraphPrimitive>[0]['tasks'] }) {
  return <FlamegraphPrimitive tasks={props.tasks ?? []} />
}

// --- DataTable (raw rows + declarative columns; formats internally) ---------

export type CellKind =
  | 'text'
  | 'mono'
  | 'muted'
  | 'faint'
  | FormatHint
  | 'status'
  | 'cache'
  | 'projtask'
  | 'bar'
  | 'dots'

// Conditional tone on a numeric field value, e.g. { gt: 0, tone: 'danger' }.
export interface ToneRule {
  gt?: number
  lt?: number
  ge?: number
  le?: number
  tone: Tone
  else?: Tone
}

export interface Column {
  key: string // field on the raw row (also the default sort key)
  label: string
  align?: 'left' | 'right'
  sortable?: boolean
  kind?: CellKind // how to render the field (default: plain text)
  format?: FormatHint // value format for kind:'bar'
  baseTone?: Tone // unconditional tone (e.g. dim/cache columns)
  tone?: ToneRule // conditional tone on the numeric field value (overrides baseTone)
  statusKey?: string
  cacheHitKey?: string
  projectKey?: string
  taskKey?: string
  nKey?: string
  fracKey?: string
  colorKey?: string
  dotsKeys?: string[]
  subKey?: string
}

export type Row = Record<string, unknown>

const TEXTISH = new Set(['text', 'mono', 'muted', 'faint'])

function fieldTone(rule: ToneRule, v: number): Tone {
  const hit =
    (rule.gt !== undefined && v > rule.gt) ||
    (rule.lt !== undefined && v < rule.lt) ||
    (rule.ge !== undefined && v >= rule.ge) ||
    (rule.le !== undefined && v <= rule.le)
  return hit ? rule.tone : (rule.else ?? 'default')
}

function renderField(col: Column, row: Row) {
  const raw = row[col.key]
  switch (col.kind) {
    case 'status':
      return (
        <StatusBadge status={String(row[col.statusKey ?? 'status'] ?? '')} cacheHit={row[col.cacheHitKey ?? 'cacheHit'] as boolean | null} />
      )
    case 'cache':
      return <span class={toneText('cache')}>{row[col.cacheHitKey ?? 'cacheHit'] === true ? 'hit' : 'miss'}</span>
    case 'projtask':
      return (
        <span>
          <Show when={col.nKey !== undefined && row[col.nKey!] !== undefined}>
            <span class="text-fg-3 text-[10px] mr-2">{String(row[col.nKey!])}.</span>
          </Show>
          <span class="text-fg-3">{String(row[col.projectKey ?? 'project'])}#</span>
          {String(row[col.taskKey ?? 'task'])}
        </span>
      )
    case 'dots':
      return (
        <div class="flex items-center gap-2 min-w-0">
          <For each={(col.dotsKeys ?? []).map((k) => row[k]).filter(Boolean) as string[]}>{(c) => <Dot color={c} />}</For>
          <span class="truncate">{String(raw)}</span>
          <Show when={col.subKey && row[col.subKey] !== undefined}>
            <span class="text-fg-3 text-[10px] shrink-0">{String(row[col.subKey!])}</span>
          </Show>
        </div>
      )
    case 'bar':
      return (
        <div class="flex items-center gap-2 justify-end">
          <span class="w-16 text-right">{formatValue(col.format, Number(raw))}</span>
          <div class="w-20">
            <HBar fraction={Number(row[col.fracKey ?? '_frac'] ?? 0)} colorClass={`bg-${row[col.colorKey ?? '_color'] ?? 'accent'}`} />
          </div>
        </div>
      )
  }
  if (raw === null || raw === undefined || raw === '') return <span class="text-fg-3">—</span>
  const display = col.kind && !TEXTISH.has(col.kind) ? formatValue(col.kind as FormatHint, Number(raw)) : String(raw)
  const tone = col.tone
    ? fieldTone(col.tone, Number(raw))
    : (col.baseTone ?? (col.kind === 'muted' || col.kind === 'faint' ? 'faint' : undefined))
  const cls = [tone ? toneText(tone) : '', col.kind === 'muted' ? 'text-[10px]' : ''].filter(Boolean).join(' ')
  return cls ? <span class={cls}>{display}</span> : <>{display}</>
}

export function DataTable(props: {
  rows: Row[]
  columns: Column[]
  rowHrefKey?: string
  filter?: boolean
  filterKey?: string
  filterPlaceholder?: string
  initialSort?: { key: string; desc?: boolean }
  emptyTitle?: string
  emptyHint?: string
  emptyCmd?: string
}) {
  const navigate = useNavigate()
  const [sortKey, setSortKey] = createSignal(props.initialSort?.key ?? '')
  const [sortDesc, setSortDesc] = createSignal(props.initialSort?.desc ?? true)
  const [filterText, setFilterText] = createSignal('')

  const rows = createMemo(() => {
    let rs = props.rows ?? []
    const f = filterText().toLowerCase().trim()
    if (f) {
      const fk = props.filterKey
      rs = rs.filter((r) => String(fk ? (r[fk] ?? '') : JSON.stringify(r)).toLowerCase().includes(f))
    }
    const k = sortKey()
    if (k) {
      rs = [...rs].sort((a, b) => {
        const av = (a[k] ?? 0) as number | string
        const bv = (b[k] ?? 0) as number | string
        const cmp = av === bv ? 0 : av > bv ? 1 : -1
        return sortDesc() ? -cmp : cmp
      })
    }
    return rs
  })

  function onSort(col: Column) {
    if (!col.sortable) return
    if (sortKey() === col.key) setSortDesc(!sortDesc())
    else {
      setSortKey(col.key)
      setSortDesc(true)
    }
  }

  const hrefOf = (row: Row) => (props.rowHrefKey ? (row[props.rowHrefKey] as string | undefined) : undefined)

  return (
    <div>
      <Show when={props.filter}>
        <div class="px-4 py-2 border-b border-border">
          <input
            type="text"
            placeholder={props.filterPlaceholder ?? 'filter…'}
            value={filterText()}
            onInput={(e) => setFilterText(e.currentTarget.value)}
            class="text-[12px] font-mono w-72"
          />
        </div>
      </Show>
      <Show when={rows().length > 0} fallback={<EmptyState title={props.emptyTitle ?? 'No data'} hint={props.emptyHint} cmd={props.emptyCmd} />}>
        <table class="w-full text-[12px]">
          <thead class="bg-surface-2/40">
            <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
              <For each={props.columns}>
                {(col) => (
                  <th
                    class="px-4 py-2 font-semibold select-none"
                    classList={{
                      'text-left': col.align !== 'right',
                      'text-right': col.align === 'right',
                      'cursor-pointer hover:text-fg': !!col.sortable,
                      'text-fg': sortKey() === col.key,
                    }}
                    onClick={() => onSort(col)}
                  >
                    {col.label}
                    <Show when={col.sortable && sortKey() === col.key}>
                      <span class="ml-1">{sortDesc() ? '↓' : '↑'}</span>
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row) => {
                const href = hrefOf(row)
                return (
                  <tr
                    class="border-t border-border"
                    classList={{ 'hover:bg-surface-hover cursor-pointer': !!href }}
                    onClick={() => href && navigate(href)}
                  >
                    <For each={props.columns}>
                      {(col) => (
                        <td class="px-4 py-2 font-mono" classList={{ 'text-left': col.align !== 'right', 'text-right': col.align === 'right' }}>
                          {renderField(col, row)}
                        </td>
                      )}
                    </For>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  )
}

// --- RankList (leaderboard-style rows from raw items) -----------------------

export function RankList(props: {
  items: Row[]
  labelKey: string
  valueKey: string
  valueFormat?: FormatHint
  indexed?: boolean
  metaKey?: string
  metaPrefix?: string
  metaSuffix?: string
  metaFormat?: FormatHint
  dotsKeys?: string[]
  colorKey?: string
  fracKey?: string
  hrefKey?: string
  subKey?: string
  emptyTitle?: string
  emptyCmd?: string
}) {
  const navigate = useNavigate()
  const meta = (it: Row) => {
    if (!props.metaKey || it[props.metaKey] === undefined) return undefined
    const v = props.metaFormat ? formatValue(props.metaFormat, Number(it[props.metaKey])) : String(it[props.metaKey])
    return `${props.metaPrefix ?? ''}${v}${props.metaSuffix ?? ''}`
  }
  return (
    <Show when={(props.items ?? []).length > 0} fallback={<EmptyState title={props.emptyTitle ?? 'Nothing yet'} cmd={props.emptyCmd} />}>
      <div class="flex flex-col">
        <For each={props.items}>
          {(it, i) => {
            const href = it[props.hrefKey ?? '_href'] as string | undefined
            const frac = it[props.fracKey ?? '_frac'] as number | undefined
            return (
              <button
                onClick={() => href && navigate(href)}
                class="flex flex-col gap-1 px-4 py-2 text-left border-t border-border first:border-t-0"
                classList={{ 'hover:bg-surface-hover': !!href, 'cursor-default': !href }}
              >
                <div class="flex items-center gap-2 text-[12px] min-w-0">
                  <Show when={props.indexed}>
                    <span class="text-[10px] font-mono text-fg-3 w-4 shrink-0">{i() + 1}.</span>
                  </Show>
                  <For each={(props.dotsKeys ?? []).map((k) => it[k]).filter(Boolean) as string[]}>{(c) => <Dot color={c} />}</For>
                  <span class="font-mono truncate flex-1">{String(it[props.labelKey])}</span>
                  <Show when={props.subKey && it[props.subKey] !== undefined}>
                    <span class="text-fg-3 text-[10px] shrink-0">{String(it[props.subKey!])}</span>
                  </Show>
                  <Show when={meta(it) !== undefined}>
                    <span class="text-fg-3 font-mono text-[10px] shrink-0">{meta(it)}</span>
                  </Show>
                  <span class="font-mono shrink-0">{formatValue(props.valueFormat, Number(it[props.valueKey]))}</span>
                </div>
                <Show when={frac !== undefined}>
                  <HBar fraction={frac!} colorClass={`bg-${it[props.colorKey ?? '_color'] ?? 'accent'}`} />
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

// --- LiveActivity (self-contained SSE ticker) -------------------------------

export function LiveActivity(props: { max?: number }) {
  const max = () => props.max ?? 12
  const [live, setLive] = createSignal<Array<{ id: number; kind: string; label: string; t: number }>>([])
  let seq = 0
  onMount(() => {
    const unsub = subscribeEvents((env: unknown) => {
      const ev = (env as { params?: { kind?: string; node?: { id?: string }; outcome?: { node?: { id?: string }; status?: string } } }).params
      if (!ev?.kind) return
      let label = ''
      if (ev.kind === 'task:start') label = `▶ ${ev.node?.id ?? ''}`
      else if (ev.kind === 'task:complete') label = `${ev.outcome?.status === 'failed' ? '✗' : '✓'} ${ev.outcome?.node?.id ?? ''}`
      else if (ev.kind === 'run:start') label = '· run started'
      else if (ev.kind === 'run:end') label = '· run finished'
      else return
      setLive((prev) => [{ id: ++seq, kind: ev.kind!, label, t: Date.now() }, ...prev].slice(0, max()))
    })
    onCleanup(unsub)
  })
  return (
    <Show when={live().length > 0} fallback={<div class="text-fg-3 text-xs text-center py-6">Waiting for events…</div>}>
      <div class="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
        <For each={live()}>
          {(e) => (
            <div class="flex items-center gap-2 text-[11px] font-mono">
              <span class="text-fg-3 w-12 shrink-0">{formatHour(e.t)}</span>
              <span
                class={
                  e.kind === 'task:complete' && e.label.startsWith('✗')
                    ? 'text-danger truncate'
                    : e.kind === 'task:complete'
                      ? 'text-success truncate'
                      : e.kind.startsWith('run:')
                        ? 'text-fg-3 truncate'
                        : 'text-fg-1 truncate'
                }
              >
                {e.label}
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
