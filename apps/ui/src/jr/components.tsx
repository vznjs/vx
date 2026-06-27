// The dashboard component catalog — plain Solid components, fully data-driven so
// page specs can pass RAW `/v1/*` rows + declarative config. All derivation
// (palette colors, link templates, bar fractions, CPU%, chart field extraction,
// truncation) lives HERE, so the pages stay pure JSON. The same components are
// registered with json-render (renderer.tsx) and rendered from JSON specs.

import { For, Show, type JSX, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { A, useNavigate } from '@solidjs/router'
import { subscribeEvents } from '../api.ts'
import { HBar, Heatmap as HeatmapPrimitive, LineChart as LineChartPrimitive, Treemap as TreemapPrimitive } from '../components/charts.tsx'
import { Card as UiCard, EmptyState, MetricCard, StatusBadge } from '../components/ui.tsx'
import { Flamegraph as FlamegraphPrimitive } from '../components/Flamegraph.tsx'
import { formatHour, paletteFor } from '../format.ts'
import { type FormatHint, type Tone, axisFormatter, formatValue, toneText } from './hints.ts'

type Row = Record<string, unknown>
const enc = encodeURIComponent

/** Replace `{field}` in a template with the URL-encoded row value (for hrefs). */
function interpolate(tpl: string, row: Row): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, f) => enc(String(row[f] ?? '')))
}
/** Replace `{field}` with the raw row value (for display labels). */
function interpolateRaw(tpl: string, row: Row): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, f) => String(row[f] ?? ''))
}
function colorOf(map: 'palette' | 'failureMode', v: unknown): string {
  if (map === 'failureMode') return v === 'stable' ? 'success' : v === 'flaky-recoverable' ? 'warn' : 'danger'
  return paletteFor(String(v))
}

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

const STACK: Record<string, string> = { '2': 'flex flex-col gap-2', '3': 'flex flex-col gap-3', '4': 'flex flex-col gap-4', '5': 'flex flex-col gap-5' }
export function Stack(props: { gap?: '2' | '3' | '4' | '5'; children?: JSX.Element }) {
  return <div class={STACK[props.gap ?? '4']}>{props.children}</div>
}

// --- Content ----------------------------------------------------------------

export function Card(props: { title?: string; actionText?: string; actionHref?: string; actionLabel?: string; noPad?: boolean; children?: JSX.Element }) {
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

export function Metric(props: { label: string; value: string; sub?: string; tone?: 'default' | 'good' | 'warn' | 'bad'; delta?: number }) {
  return <MetricCard label={props.label} value={props.value} sub={props.sub} tone={props.tone} delta={props.delta} />
}

export function Text(props: { text: string; tone?: Tone; mono?: boolean; class?: string }) {
  const cls = () => ['text-[12px]', toneText(props.tone), props.mono ? 'font-mono' : '', props.class ?? ''].filter(Boolean).join(' ')
  return <div class={cls()}>{props.text}</div>
}

export function Empty(props: { title: string; hint?: string; cmd?: string }) {
  return <EmptyState title={props.title} hint={props.hint} cmd={props.cmd} />
}

// Key/value facts from one entry object + a declarative field list.
export function Facts(props: {
  entry?: Row
  fields: Array<{ label: string; key: string; kind?: FormatHint | 'shorthash' | 'shorthash16' | 'text'; mono?: boolean }>
  commandKey?: string
}) {
  const fmt = (f: { key: string; kind?: string }) => {
    const v = props.entry?.[f.key]
    if (v === undefined || v === null) return '—'
    if (f.kind === 'shorthash') return `${String(v).slice(0, 10)}…`
    if (f.kind === 'shorthash16') return `${String(v).slice(0, 16)}…`
    if (!f.kind || f.kind === 'text') return String(v)
    return formatValue(f.kind as FormatHint, Number(v))
  }
  return (
    <div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12px]">
        <For each={props.fields}>
          {(f) => (
            <div class="flex gap-3 items-baseline">
              <span class="text-fg-3 text-[10px] uppercase tracking-wider w-20 shrink-0">{f.label}</span>
              <span class={f.mono || f.kind === 'shorthash' || f.kind === 'shorthash16' ? 'font-mono text-fg-1' : ''}>{fmt(f)}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.commandKey && props.entry?.[props.commandKey]}>
        <div class="mt-3 text-[11px] text-fg-3">
          $ <code class="text-fg-1 font-mono">{String(props.entry![props.commandKey!])}</code>
        </div>
      </Show>
    </div>
  )
}

// --- Charts (raw rows + field keys) -----------------------------------------

interface ChartSeries {
  name: string
  yKey: string
  strokeClass: string
  areaClass?: string
}
export function LineChart(props: {
  rows: Row[]
  xKey?: string // omit → use row index
  reverse?: boolean
  series: ChartSeries[]
  xFormat?: FormatHint
  yFormat?: FormatHint
  height?: number
  yMin?: number
}) {
  const rows = () => {
    const rs = props.rows ?? []
    return props.reverse ? [...rs].reverse() : rs
  }
  const xs = () => (props.xKey ? rows().map((r) => Number(r[props.xKey!])) : rows().map((_, i) => i))
  const series = () => (props.series ?? []).map((s) => ({ name: s.name, strokeClass: s.strokeClass, areaClass: s.areaClass, data: rows().map((r) => Number(r[s.yKey])) }))
  return (
    <Show when={rows().length > 0} fallback={<EmptyState title="No data yet" />}>
      <LineChartPrimitive xs={xs()} series={series()} formatX={axisFormatter(props.xFormat)} formatY={axisFormatter(props.yFormat)} height={props.height} yMin={props.yMin} />
    </Show>
  )
}

export function Treemap(props: { rows: Row[]; labelKey: string; valueKey: string; colorFrom?: string; valueFormat?: FormatHint; height?: number }) {
  const data = () =>
    (props.rows ?? [])
      .filter((r) => Number(r[props.valueKey]) > 0)
      .map((r) => ({ label: String(r[props.labelKey]), value: Number(r[props.valueKey]), colorClass: `fill-${paletteFor(String(r[props.colorFrom ?? props.labelKey]))}` }))
  return (
    <Show when={data().length > 0} fallback={<EmptyState title="No cached output yet" />}>
      <TreemapPrimitive data={data()} height={props.height} format={(v) => formatValue(props.valueFormat, v)} />
    </Show>
  )
}

export function Heatmap(props: { rows: Row[]; dayKey?: string; hourKey?: string; valueKey: string; cellSize?: number; valueFormat?: FormatHint }) {
  const data = () =>
    (props.rows ?? []).map((r) => ({ dayOfWeek: Number(r[props.dayKey ?? 'dayOfWeek']), hourOfDay: Number(r[props.hourKey ?? 'hourOfDay']), value: Number(r[props.valueKey]) }))
  return (
    <Show when={data().some((c) => c.value > 0)} fallback={<EmptyState title="No runs in the window" />}>
      <HeatmapPrimitive data={data()} cellSize={props.cellSize} format={(v) => (props.valueFormat ? formatValue(props.valueFormat, v) : `${v} runs`)} />
    </Show>
  )
}

export function Flamegraph(props: { rows: Parameters<typeof FlamegraphPrimitive>[0]['tasks'] }) {
  return <FlamegraphPrimitive tasks={props.rows ?? []} />
}

// --- DataTable --------------------------------------------------------------

type CellKind = 'text' | 'mono' | 'muted' | 'faint' | FormatHint | 'cpuPct' | 'status' | 'cache' | 'projtask' | 'bar' | 'dots' | 'shorthash'
interface ToneRule {
  gt?: number
  lt?: number
  ge?: number
  le?: number
  tone: Tone
  else?: Tone
}
export interface Column {
  key: string
  label: string
  align?: 'left' | 'right'
  sortable?: boolean
  kind?: CellKind
  format?: FormatHint // value format for kind:'bar'
  baseTone?: Tone
  tone?: ToneRule
  color?: string // static bar color token
  colorFrom?: string // bar color via paletteFor(row[colorFrom])
  dots?: Array<{ field: string; map: 'palette' | 'failureMode' }>
  projectKey?: string
  taskKey?: string
  nKey?: string
  statusKey?: string
  cacheHitKey?: string
  cpuKey?: string
  durKey?: string
  hitKey?: string
  len?: number // shorthash length
}
const TEXTISH = new Set(['text', 'mono', 'muted', 'faint'])

function fieldTone(rule: ToneRule, v: number): Tone {
  const hit = (rule.gt !== undefined && v > rule.gt) || (rule.lt !== undefined && v < rule.lt) || (rule.ge !== undefined && v >= rule.ge) || (rule.le !== undefined && v <= rule.le)
  return hit ? rule.tone : (rule.else ?? 'default')
}

function renderField(col: Column, row: Row, max: number) {
  switch (col.kind) {
    case 'status':
      return <StatusBadge status={String(row[col.statusKey ?? 'status'] ?? '')} cacheHit={row[col.cacheHitKey ?? 'cacheHit'] as boolean | null} />
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
          <For each={col.dots ?? []}>{(d) => <Dot color={colorOf(d.map, row[d.field])} />}</For>
          <span class="truncate">{String(row[col.key])}</span>
        </div>
      )
    case 'bar': {
      const v = Number(row[col.key])
      const color = col.colorFrom ? paletteFor(String(row[col.colorFrom])) : (col.color ?? 'accent')
      return (
        <div class="flex items-center gap-2 justify-end">
          <span class="w-16 text-right">{formatValue(col.format, v)}</span>
          <div class="w-20">
            <HBar fraction={max > 0 ? v / max : 0} colorClass={`bg-${color}`} />
          </div>
        </div>
      )
    }
    case 'cpuPct': {
      const cpuMs = row[col.cpuKey ?? 'cpuMs']
      const durationMs = Number(row[col.durKey ?? 'durationMs'])
      const hit = row[col.hitKey ?? 'cacheHit']
      const pct = cpuMs !== null && cpuMs !== undefined && durationMs > 0 && hit !== true ? (Number(cpuMs) / durationMs) * 100 : undefined
      const tone: Tone = pct !== undefined && pct > 100 ? 'success' : 'faint'
      return <span class={toneText(tone)}>{pct !== undefined ? `${Math.round(pct)}%` : '—'}</span>
    }
    case 'shorthash':
      return <span class="text-fg-3 text-[10px]">{row[col.key] !== undefined ? `${String(row[col.key]).slice(0, col.len ?? 10)}…` : '—'}</span>
  }
  const raw = row[col.key]
  if (raw === null || raw === undefined || raw === '') return <span class="text-fg-3">—</span>
  const display = col.kind && !TEXTISH.has(col.kind) ? formatValue(col.kind as FormatHint, Number(raw)) : String(raw)
  const tone = col.tone ? fieldTone(col.tone, Number(raw)) : (col.baseTone ?? (col.kind === 'muted' || col.kind === 'faint' ? 'faint' : undefined))
  const cls = [tone ? toneText(tone) : '', col.kind === 'muted' ? 'text-[10px]' : ''].filter(Boolean).join(' ')
  return cls ? <span class={cls}>{display}</span> : <>{display}</>
}

export function DataTable(props: {
  rows: Row[]
  columns: Column[]
  rowHref?: string // template e.g. /projects/{project}
  rowTaskRef?: { projectKey?: string; taskKey?: string } // → /tasks/<enc(project#task)>
  filter?: boolean
  filterFrom?: string[]
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

  const maxes = createMemo(() => {
    const m: Record<string, number> = {}
    for (const col of props.columns ?? []) if (col.kind === 'bar') m[col.key] = Math.max(1, ...(props.rows ?? []).map((r) => Number(r[col.key])))
    return m
  })
  const rows = createMemo(() => {
    let rs = props.rows ?? []
    const f = filterText().toLowerCase().trim()
    if (f) {
      const keys = props.filterFrom
      rs = rs.filter((r) => String(keys ? keys.map((k) => r[k]).join(' ') : JSON.stringify(r)).toLowerCase().includes(f))
    }
    const k = sortKey()
    if (k) rs = [...rs].sort((a, b) => { const av = (a[k] ?? 0) as number | string, bv = (b[k] ?? 0) as number | string; const c = av === bv ? 0 : av > bv ? 1 : -1; return sortDesc() ? -c : c })
    return rs
  })
  const hrefOf = (row: Row) => {
    if (props.rowTaskRef) return `/tasks/${enc(`${row[props.rowTaskRef.projectKey ?? 'project']}#${row[props.rowTaskRef.taskKey ?? 'task']}`)}`
    if (props.rowHref) return interpolate(props.rowHref, row)
    return undefined
  }
  const onSort = (col: Column) => {
    if (!col.sortable) return
    if (sortKey() === col.key) setSortDesc(!sortDesc())
    else { setSortKey(col.key); setSortDesc(true) }
  }

  return (
    <div>
      <Show when={props.filter}>
        <div class="px-4 py-2 border-b border-border">
          <input type="text" placeholder={props.filterPlaceholder ?? 'filter…'} value={filterText()} onInput={(e) => setFilterText(e.currentTarget.value)} class="text-[12px] font-mono w-72" />
        </div>
      </Show>
      <Show when={rows().length > 0} fallback={<EmptyState title={props.emptyTitle ?? 'No data'} hint={props.emptyHint} cmd={props.emptyCmd} />}>
        <table class="w-full text-[12px]">
          <thead class="bg-surface-2/40">
            <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
              <For each={props.columns}>
                {(col) => (
                  <th class="px-4 py-2 font-semibold select-none" classList={{ 'text-left': col.align !== 'right', 'text-right': col.align === 'right', 'cursor-pointer hover:text-fg': !!col.sortable, 'text-fg': sortKey() === col.key }} onClick={() => onSort(col)}>
                    {col.label}
                    <Show when={col.sortable && sortKey() === col.key}><span class="ml-1">{sortDesc() ? '↓' : '↑'}</span></Show>
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
                  <tr class="border-t border-border" classList={{ 'hover:bg-surface-hover cursor-pointer': !!href }} onClick={() => href && navigate(href)}>
                    <For each={props.columns}>
                      {(col) => (
                        <td class="px-4 py-2 font-mono" classList={{ 'text-left': col.align !== 'right', 'text-right': col.align === 'right' }}>
                          {renderField(col, row, maxes()[col.key] ?? 1)}
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

// --- RankList ---------------------------------------------------------------

export function RankList(props: {
  items: Row[]
  labelKey?: string
  labelTemplate?: string // display label e.g. "{project}#{task}"
  valueKey: string
  valueFormat?: FormatHint
  indexed?: boolean
  metaKey?: string
  metaPrefix?: string
  metaSuffix?: string
  metaFormat?: FormatHint
  dots?: Array<{ field: string; map: 'palette' | 'failureMode' }>
  barFrom?: string // value field → fraction (max computed internally)
  colorFrom?: string // bar color via paletteFor(item[colorFrom])
  rowHref?: string
  rowTaskRef?: { projectKey?: string; taskKey?: string }
  subKey?: string
  limit?: number
  emptyTitle?: string
  emptyCmd?: string
}) {
  const navigate = useNavigate()
  const items = () => (props.limit ? (props.items ?? []).slice(0, props.limit) : (props.items ?? []))
  const max = createMemo(() => (props.barFrom ? Math.max(1, ...items().map((it) => Number(it[props.barFrom!]))) : 1))
  const meta = (it: Row) => {
    if (!props.metaKey || it[props.metaKey] === undefined) return undefined
    const v = props.metaFormat ? formatValue(props.metaFormat, Number(it[props.metaKey])) : String(it[props.metaKey])
    return `${props.metaPrefix ?? ''}${v}${props.metaSuffix ?? ''}`
  }
  const hrefOf = (it: Row) => {
    if (props.rowTaskRef) return `/tasks/${enc(`${it[props.rowTaskRef.projectKey ?? 'project']}#${it[props.rowTaskRef.taskKey ?? 'task']}`)}`
    if (props.rowHref) return interpolate(props.rowHref, it)
    return undefined
  }
  return (
    <Show when={items().length > 0} fallback={<EmptyState title={props.emptyTitle ?? 'Nothing yet'} cmd={props.emptyCmd} />}>
      <div class="flex flex-col">
        <For each={items()}>
          {(it, i) => {
            const href = hrefOf(it)
            return (
              <button onClick={() => href && navigate(href)} class="flex flex-col gap-1 px-4 py-2 text-left border-t border-border first:border-t-0" classList={{ 'hover:bg-surface-hover': !!href, 'cursor-default': !href }}>
                <div class="flex items-center gap-2 text-[12px] min-w-0">
                  <Show when={props.indexed}><span class="text-[10px] font-mono text-fg-3 w-4 shrink-0">{i() + 1}.</span></Show>
                  <For each={props.dots ?? []}>{(d) => <Dot color={colorOf(d.map, it[d.field])} />}</For>
                  <span class="font-mono truncate flex-1">{props.labelTemplate ? interpolateRaw(props.labelTemplate, it) : String(it[props.labelKey ?? 'id'])}</span>
                  <Show when={props.subKey && it[props.subKey] !== undefined}><span class="text-fg-3 text-[10px] shrink-0">{String(it[props.subKey!])}</span></Show>
                  <Show when={meta(it) !== undefined}><span class="text-fg-3 font-mono text-[10px] shrink-0">{meta(it)}</span></Show>
                  <span class="font-mono shrink-0">{formatValue(props.valueFormat, Number(it[props.valueKey]))}</span>
                </div>
                <Show when={props.barFrom}>
                  <HBar fraction={Number(it[props.barFrom!]) / max()} colorClass={`bg-${props.colorFrom ? paletteFor(String(it[props.colorFrom])) : 'accent'}`} />
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

// --- LiveActivity -----------------------------------------------------------

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
              <span class={e.kind === 'task:complete' && e.label.startsWith('✗') ? 'text-danger truncate' : e.kind === 'task:complete' ? 'text-success truncate' : e.kind.startsWith('run:') ? 'text-fg-3 truncate' : 'text-fg-1 truncate'}>{e.label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
