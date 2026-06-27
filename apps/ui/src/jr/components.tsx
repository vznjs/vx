// The dashboard component catalog. Each component is a native json-render
// component: it receives `BaseComponentProps<P>` from the registry (see
// renderer.tsx) and reads `c.props.X` / `c.children` / `c.emit` LIVE. The
// registry hands `c.props` as a reactive getter, so reads inside JSX/accessors
// stay reactive when async state resolves — never snapshot `c.props` at setup.
//
// Components are fully data-driven: specs pass RAW `/v1/*` rows + declarative
// config, and ALL derivation (palette colors, link templates, bar fractions,
// CPU%, chart field extraction, truncation) lives HERE, so the pages stay pure
// JSON.

import { For, Show, type JSX, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { BaseComponentProps } from '@json-render/solid'
import { A, useNavigate } from '@solidjs/router'
import { subscribeEvents } from '../api.ts'
import { HBar, Heatmap as HeatmapPrimitive, LineChart as LineChartPrimitive, Treemap as TreemapPrimitive } from '../components/charts.tsx'
import { Card as UiCard, EmptyState, MetricCard, StatusBadge } from '../components/ui.tsx'
import { Flamegraph as FlamegraphPrimitive } from '../components/Flamegraph.tsx'
import { formatHour, paletteFor } from '../format.ts'
import { type FormatHint, type Tone, axisFormatter, formatValue, toneText } from './hints.ts'

type Row = Record<string, unknown>
type C<P> = BaseComponentProps<P>
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

export function Page(c: C<{ title?: string; subtitle?: string; backHref?: string; backLabel?: string; dotColor?: string; mono?: boolean }>) {
  return (
    <div class="flex flex-col gap-5">
      <Show when={c.props.backHref}>
        <div class="flex items-center gap-3">
          <A href={c.props.backHref!} class="text-fg-3 hover:text-fg no-underline text-[11px] font-mono">
            ← {c.props.backLabel ?? 'back'}
          </A>
          <Show when={c.props.dotColor}>
            <span class={`inline-block w-2 h-2 rounded-full bg-${c.props.dotColor}`} />
          </Show>
          <h1 class={`text-base font-semibold m-0 ${c.props.mono ? 'font-mono' : ''}`}>{c.props.title}</h1>
        </div>
      </Show>
      <Show when={!c.props.backHref && (c.props.title || c.props.subtitle)}>
        <div>
          <Show when={c.props.title}>
            <h1 class="text-base font-semibold m-0">{c.props.title}</h1>
          </Show>
          <Show when={c.props.subtitle}>
            <p class="text-fg-3 text-[12px] mt-1 m-0">{c.props.subtitle}</p>
          </Show>
        </div>
      </Show>
      {c.children}
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
export function Grid(c: C<{ variant?: keyof typeof GRID }>) {
  return <div class={GRID[c.props.variant ?? 'cols-2'] ?? GRID['cols-2']}>{c.children}</div>
}

const STACK: Record<string, string> = { '2': 'flex flex-col gap-2', '3': 'flex flex-col gap-3', '4': 'flex flex-col gap-4', '5': 'flex flex-col gap-5' }
export function Stack(c: C<{ gap?: '2' | '3' | '4' | '5' }>) {
  return <div class={STACK[c.props.gap ?? '4']}>{c.children}</div>
}

// --- Content ----------------------------------------------------------------

export function Card(c: C<{ title?: string; actionText?: string; actionHref?: string; actionLabel?: string; noPad?: boolean }>) {
  const action = () =>
    c.props.actionHref ? (
      <A href={c.props.actionHref} class="text-[11px] text-accent no-underline hover:underline">
        {c.props.actionLabel ?? 'more'}
      </A>
    ) : c.props.actionText ? (
      <span class="text-[10px] text-fg-3 font-mono">{c.props.actionText}</span>
    ) : undefined
  return (
    <UiCard title={c.props.title} action={action()} noPad={c.props.noPad}>
      {c.children}
    </UiCard>
  )
}

export function Metric(c: C<{ label: string; value: string; sub?: string; tone?: 'default' | 'good' | 'warn' | 'bad'; delta?: number }>) {
  return <MetricCard label={c.props.label} value={c.props.value} sub={c.props.sub} tone={c.props.tone} delta={c.props.delta} />
}

export function Text(c: C<{ text: string; tone?: Tone; mono?: boolean; class?: string }>) {
  const cls = () => ['text-[12px]', toneText(c.props.tone), c.props.mono ? 'font-mono' : '', c.props.class ?? ''].filter(Boolean).join(' ')
  return <div class={cls()}>{c.props.text}</div>
}

export function Empty(c: C<{ title: string; hint?: string; cmd?: string }>) {
  return <EmptyState title={c.props.title} hint={c.props.hint} cmd={c.props.cmd} />
}

// Key/value facts from one entry object + a declarative field list.
type FactField = { label: string; key: string; kind?: FormatHint | 'shorthash' | 'shorthash16' | 'text'; mono?: boolean }
export function Facts(c: C<{ entry?: Row; fields: FactField[]; commandKey?: string }>) {
  const fmt = (f: FactField) => {
    const v = c.props.entry?.[f.key]
    if (v === undefined || v === null) return '—'
    if (f.kind === 'shorthash') return `${String(v).slice(0, 10)}…`
    if (f.kind === 'shorthash16') return `${String(v).slice(0, 16)}…`
    if (!f.kind || f.kind === 'text') return String(v)
    return formatValue(f.kind as FormatHint, Number(v))
  }
  return (
    <div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12px]">
        <For each={c.props.fields}>
          {(f) => (
            <div class="flex gap-3 items-baseline">
              <span class="text-fg-3 text-[10px] uppercase tracking-wider w-20 shrink-0">{f.label}</span>
              <span class={f.mono || f.kind === 'shorthash' || f.kind === 'shorthash16' ? 'font-mono text-fg-1' : ''}>{fmt(f)}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={c.props.commandKey && c.props.entry?.[c.props.commandKey]}>
        <div class="mt-3 text-[11px] text-fg-3">
          $ <code class="text-fg-1 font-mono">{String(c.props.entry![c.props.commandKey!])}</code>
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
export function LineChart(c: C<{ rows: Row[]; xKey?: string; reverse?: boolean; series: ChartSeries[]; xFormat?: FormatHint; yFormat?: FormatHint; height?: number; yMin?: number }>) {
  const rows = () => {
    const rs = c.props.rows ?? []
    return c.props.reverse ? [...rs].reverse() : rs
  }
  const xs = () => (c.props.xKey ? rows().map((r) => Number(r[c.props.xKey!])) : rows().map((_, i) => i))
  const series = () => (c.props.series ?? []).map((s) => ({ name: s.name, strokeClass: s.strokeClass, areaClass: s.areaClass, data: rows().map((r) => Number(r[s.yKey])) }))
  return (
    <Show when={rows().length > 0} fallback={<EmptyState title="No data yet" />}>
      <LineChartPrimitive xs={xs()} series={series()} formatX={axisFormatter(c.props.xFormat)} formatY={axisFormatter(c.props.yFormat)} height={c.props.height} yMin={c.props.yMin} />
    </Show>
  )
}

export function Treemap(c: C<{ rows: Row[]; labelKey: string; valueKey: string; colorFrom?: string; valueFormat?: FormatHint; height?: number }>) {
  const data = () =>
    (c.props.rows ?? [])
      .filter((r) => Number(r[c.props.valueKey]) > 0)
      .map((r) => ({ label: String(r[c.props.labelKey]), value: Number(r[c.props.valueKey]), colorClass: `fill-${paletteFor(String(r[c.props.colorFrom ?? c.props.labelKey]))}` }))
  return (
    <Show when={data().length > 0} fallback={<EmptyState title="No cached output yet" />}>
      <TreemapPrimitive data={data()} height={c.props.height} format={(v) => formatValue(c.props.valueFormat, v)} />
    </Show>
  )
}

export function Heatmap(c: C<{ rows: Row[]; dayKey?: string; hourKey?: string; valueKey: string; cellSize?: number; valueFormat?: FormatHint }>) {
  const data = () =>
    (c.props.rows ?? []).map((r) => ({ dayOfWeek: Number(r[c.props.dayKey ?? 'dayOfWeek']), hourOfDay: Number(r[c.props.hourKey ?? 'hourOfDay']), value: Number(r[c.props.valueKey]) }))
  return (
    <Show when={data().some((cell) => cell.value > 0)} fallback={<EmptyState title="No runs in the window" />}>
      <HeatmapPrimitive data={data()} cellSize={c.props.cellSize} format={(v) => (c.props.valueFormat ? formatValue(c.props.valueFormat, v) : `${v} runs`)} />
    </Show>
  )
}

export function Flamegraph(c: C<{ rows: Parameters<typeof FlamegraphPrimitive>[0]['tasks'] }>) {
  return <FlamegraphPrimitive tasks={c.props.rows ?? []} />
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

export function DataTable(
  c: C<{
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
  }>,
) {
  const navigate = useNavigate()
  const [sortKey, setSortKey] = createSignal(c.props.initialSort?.key ?? '')
  const [sortDesc, setSortDesc] = createSignal(c.props.initialSort?.desc ?? true)
  const [filterText, setFilterText] = createSignal('')

  const maxes = createMemo(() => {
    const m: Record<string, number> = {}
    for (const col of c.props.columns ?? []) if (col.kind === 'bar') m[col.key] = Math.max(1, ...(c.props.rows ?? []).map((r) => Number(r[col.key])))
    return m
  })
  const rows = createMemo(() => {
    let rs = c.props.rows ?? []
    const f = filterText().toLowerCase().trim()
    if (f) {
      const keys = c.props.filterFrom
      rs = rs.filter((r) => String(keys ? keys.map((k) => r[k]).join(' ') : JSON.stringify(r)).toLowerCase().includes(f))
    }
    const k = sortKey()
    if (k) rs = [...rs].sort((a, b) => { const av = (a[k] ?? 0) as number | string, bv = (b[k] ?? 0) as number | string; const cmp = av === bv ? 0 : av > bv ? 1 : -1; return sortDesc() ? -cmp : cmp })
    return rs
  })
  const hrefOf = (row: Row) => {
    const ref = c.props.rowTaskRef
    if (ref) return `/tasks/${enc(`${row[ref.projectKey ?? 'project']}#${row[ref.taskKey ?? 'task']}`)}`
    if (c.props.rowHref) return interpolate(c.props.rowHref, row)
    return undefined
  }
  const onSort = (col: Column) => {
    if (!col.sortable) return
    if (sortKey() === col.key) setSortDesc(!sortDesc())
    else { setSortKey(col.key); setSortDesc(true) }
  }

  return (
    <div>
      <Show when={c.props.filter}>
        <div class="px-4 py-2 border-b border-border">
          <input type="text" placeholder={c.props.filterPlaceholder ?? 'filter…'} value={filterText()} onInput={(e) => setFilterText(e.currentTarget.value)} class="text-[12px] font-mono w-72" />
        </div>
      </Show>
      <Show when={rows().length > 0} fallback={<EmptyState title={c.props.emptyTitle ?? 'No data'} hint={c.props.emptyHint} cmd={c.props.emptyCmd} />}>
        <table class="w-full text-[12px]">
          <thead class="bg-surface-2/40">
            <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
              <For each={c.props.columns}>
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
                    <For each={c.props.columns}>
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

export function RankList(
  c: C<{
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
  }>,
) {
  const navigate = useNavigate()
  const items = () => (c.props.limit ? (c.props.items ?? []).slice(0, c.props.limit) : (c.props.items ?? []))
  const max = createMemo(() => (c.props.barFrom ? Math.max(1, ...items().map((it) => Number(it[c.props.barFrom!]))) : 1))
  const meta = (it: Row) => {
    if (!c.props.metaKey || it[c.props.metaKey] === undefined) return undefined
    const v = c.props.metaFormat ? formatValue(c.props.metaFormat, Number(it[c.props.metaKey])) : String(it[c.props.metaKey])
    return `${c.props.metaPrefix ?? ''}${v}${c.props.metaSuffix ?? ''}`
  }
  const hrefOf = (it: Row) => {
    const ref = c.props.rowTaskRef
    if (ref) return `/tasks/${enc(`${it[ref.projectKey ?? 'project']}#${it[ref.taskKey ?? 'task']}`)}`
    if (c.props.rowHref) return interpolate(c.props.rowHref, it)
    return undefined
  }
  return (
    <Show when={items().length > 0} fallback={<EmptyState title={c.props.emptyTitle ?? 'Nothing yet'} cmd={c.props.emptyCmd} />}>
      <div class="flex flex-col">
        <For each={items()}>
          {(it, i) => {
            const href = hrefOf(it)
            return (
              <button onClick={() => href && navigate(href)} class="flex flex-col gap-1 px-4 py-2 text-left border-t border-border first:border-t-0" classList={{ 'hover:bg-surface-hover': !!href, 'cursor-default': !href }}>
                <div class="flex items-center gap-2 text-[12px] min-w-0">
                  <Show when={c.props.indexed}><span class="text-[10px] font-mono text-fg-3 w-4 shrink-0">{i() + 1}.</span></Show>
                  <For each={c.props.dots ?? []}>{(d) => <Dot color={colorOf(d.map, it[d.field])} />}</For>
                  <span class="font-mono truncate flex-1">{c.props.labelTemplate ? interpolateRaw(c.props.labelTemplate, it) : String(it[c.props.labelKey ?? 'id'])}</span>
                  <Show when={c.props.subKey && it[c.props.subKey!] !== undefined}><span class="text-fg-3 text-[10px] shrink-0">{String(it[c.props.subKey!])}</span></Show>
                  <Show when={meta(it) !== undefined}><span class="text-fg-3 font-mono text-[10px] shrink-0">{meta(it)}</span></Show>
                  <span class="font-mono shrink-0">{formatValue(c.props.valueFormat, Number(it[c.props.valueKey]))}</span>
                </div>
                <Show when={c.props.barFrom}>
                  <HBar fraction={Number(it[c.props.barFrom!]) / max()} colorClass={`bg-${c.props.colorFrom ? paletteFor(String(it[c.props.colorFrom])) : 'accent'}`} />
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

export function LiveActivity(c: C<{ max?: number }>) {
  const max = () => c.props.max ?? 12
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
