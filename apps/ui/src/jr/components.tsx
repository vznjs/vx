// Catalog component library for the json-render dashboard.
//
// These are the concrete Solid implementations behind every catalog component
// name. Static page specs reference them by name; the json-render Renderer
// resolves each spec's props ($state/$computed/$template/$cond) against the
// page's raw state and instantiates these. Tables/lists take RAW rows + a
// declarative column/item config and format internally — so the specs stay
// pure data and the pages only shape state, never per-cell display objects.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { A, useNavigate } from '@solidjs/router'
import { subscribeEvents } from '../api.ts'
import { HBar, Heatmap, LineChart, Treemap } from '../components/charts.tsx'
import { Card, EmptyState, MetricCard, StatusBadge } from '../components/ui.tsx'
import { Flamegraph } from '../components/Flamegraph.tsx'
import { formatHour } from '../format.ts'
import { type FormatHint, type Tone, axisFormatter, formatValue, toneText } from './hints.ts'

// Render context shape from json-render's createRenderer. `rp.element` is a
// reactive getter (it tracks the resolved-props memo), so props must be read
// LIVE, never snapshotted at setup. This proxy forwards every access to the
// current resolved props, so reading `p.x` inside JSX/memos stays reactive and
// updates when state changes (e.g. async resources resolving).
interface Ctx<P = Record<string, unknown>> {
  element: { props: P }
  children?: unknown
}
const px = <P,>(rp: Ctx<P>): P =>
  new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => (rp.element.props as Record<string, unknown>)[key as string],
  }) as P

function Dot(props: { color: string }) {
  return <span class={`inline-block w-1.5 h-1.5 rounded-full bg-${props.color} shrink-0`} />
}

// --- Layout -----------------------------------------------------------------

export function Page(
  rp: Ctx<{ title?: string; subtitle?: string; backHref?: string; backLabel?: string; dotColor?: string; mono?: boolean }>,
) {
  const p = px(rp)
  return (
    <div class="flex flex-col gap-5">
      <Show when={p.backHref}>
        <div class="flex items-center gap-3">
          <A href={p.backHref!} class="text-fg-3 hover:text-fg no-underline text-[11px] font-mono">
            ← {p.backLabel ?? 'back'}
          </A>
          <Show when={p.dotColor}>
            <span class={`inline-block w-2 h-2 rounded-full bg-${p.dotColor}`} />
          </Show>
          <h1 class={`text-base font-semibold m-0 ${p.mono ? 'font-mono' : ''}`}>{p.title}</h1>
        </div>
      </Show>
      <Show when={!p.backHref && (p.title || p.subtitle)}>
        <div>
          <Show when={p.title}>
            <h1 class="text-base font-semibold m-0">{p.title}</h1>
          </Show>
          <Show when={p.subtitle}>
            <p class="text-fg-3 text-[12px] mt-1 m-0">{p.subtitle}</p>
          </Show>
        </div>
      </Show>
      {rp.children as never}
    </div>
  )
}

export function Facts(rp: Ctx<{ items: Array<{ label: string; value: string; mono?: boolean }>; command?: string }>) {
  const p = px(rp)
  return (
    <div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12px]">
        <For each={p.items}>
          {(it) => (
            <div class="flex gap-3 items-baseline">
              <span class="text-fg-3 text-[10px] uppercase tracking-wider w-20 shrink-0">{it.label}</span>
              <span class={it.mono ? 'font-mono text-fg-1' : ''}>{it.value}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={p.command}>
        <div class="mt-3 text-[11px] text-fg-3">
          $ <code class="text-fg-1 font-mono">{p.command}</code>
        </div>
      </Show>
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

export function Grid(rp: Ctx<{ variant?: keyof typeof GRID }>) {
  const cls = () => GRID[px(rp).variant ?? 'cols-2'] ?? GRID['cols-2']
  return <div class={cls()}>{rp.children as never}</div>
}

const STACK: Record<string, string> = {
  '2': 'flex flex-col gap-2',
  '3': 'flex flex-col gap-3',
  '4': 'flex flex-col gap-4',
  '5': 'flex flex-col gap-5',
}

export function Stack(rp: Ctx<{ gap?: '2' | '3' | '4' | '5' }>) {
  return <div class={STACK[px(rp).gap ?? '4']}>{rp.children as never}</div>
}

// --- Content ----------------------------------------------------------------

export function CardEl(
  rp: Ctx<{ title?: string; actionText?: string; actionHref?: string; actionLabel?: string; noPad?: boolean }>,
) {
  const p = px(rp)
  const action = () =>
    p.actionHref ? (
      <A href={p.actionHref} class="text-[11px] text-accent no-underline hover:underline">
        {p.actionLabel ?? 'more'}
      </A>
    ) : p.actionText ? (
      <span class="text-[10px] text-fg-3 font-mono">{p.actionText}</span>
    ) : undefined
  return (
    <Card title={p.title} action={action()} noPad={p.noPad}>
      {rp.children as never}
    </Card>
  )
}

export function Metric(
  rp: Ctx<{ label: string; value: string; sub?: string; tone?: 'default' | 'good' | 'warn' | 'bad'; delta?: number }>,
) {
  const p = px(rp)
  return <MetricCard label={p.label} value={p.value} sub={p.sub} tone={p.tone} delta={p.delta} />
}

export function Text(rp: Ctx<{ text: string; tone?: Tone; mono?: boolean; class?: string }>) {
  const p = px(rp)
  // Arbitrary sizes/weights come through `class` (a literal in page source that
  // UnoCSS can scan) — never interpolated here, which would emit invalid CSS.
  const cls = () => ['text-[12px]', toneText(p.tone), p.mono ? 'font-mono' : '', p.class ?? ''].filter(Boolean).join(' ')
  return <div class={cls()}>{p.text}</div>
}

export function Empty(rp: Ctx<{ title: string; hint?: string; cmd?: string }>) {
  const p = px(rp)
  return <EmptyState title={p.title} hint={p.hint} cmd={p.cmd} />
}

// --- Charts -----------------------------------------------------------------

interface SeriesSpec {
  name: string
  strokeClass: string
  areaClass?: string
  data: number[]
}

export function LineChartEl(
  rp: Ctx<{ xs: number[]; series: SeriesSpec[]; xFormat?: FormatHint; yFormat?: FormatHint; height?: number; yMin?: number }>,
) {
  const p = px(rp)
  return (
    <LineChart
      xs={p.xs ?? []}
      series={p.series ?? []}
      formatX={axisFormatter(p.xFormat)}
      formatY={axisFormatter(p.yFormat)}
      height={p.height}
      yMin={p.yMin}
    />
  )
}

export function TreemapEl(
  rp: Ctx<{ data: Array<{ label: string; value: number; colorClass?: string }>; height?: number; valueFormat?: FormatHint }>,
) {
  const p = px(rp)
  return <Treemap data={p.data ?? []} height={p.height} format={(v) => formatValue(p.valueFormat, v)} />
}

export function HeatmapEl(
  rp: Ctx<{ data: Array<{ dayOfWeek: number; hourOfDay: number; value: number }>; cellSize?: number; valueFormat?: FormatHint }>,
) {
  const p = px(rp)
  return (
    <Heatmap
      data={p.data ?? []}
      cellSize={p.cellSize}
      format={(v) => (p.valueFormat ? formatValue(p.valueFormat, v) : `${v} runs`)}
    />
  )
}

export function FlamegraphEl(rp: Ctx<{ tasks: Parameters<typeof Flamegraph>[0]['tasks'] }>) {
  return <Flamegraph tasks={px(rp).tasks ?? []} />
}

// --- DataTable (raw rows + declarative columns; formats internally) ---------

type CellKind =
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
interface ToneRule {
  gt?: number
  lt?: number
  ge?: number
  le?: number
  tone: Tone
  else?: Tone
}

interface Column {
  key: string // field on the raw row (also the default sort key)
  label: string
  align?: 'left' | 'right'
  sortable?: boolean
  kind?: CellKind // how to render the field (default: plain text)
  format?: FormatHint // value format for kind:'bar'
  baseTone?: Tone // unconditional tone (e.g. dim/cache columns)
  tone?: ToneRule // conditional tone on the numeric field value (overrides baseTone)
  // kind-specific field references (with sensible defaults):
  statusKey?: string // 'status'
  cacheHitKey?: string // 'status'/'cache'
  projectKey?: string // 'projtask'
  taskKey?: string // 'projtask'
  nKey?: string // 'projtask' optional leading "1." index field
  fracKey?: string // 'bar' fraction (0..1) field — default '_frac'
  colorKey?: string // 'bar'/'dots' color-token field — default '_color'
  dotsKeys?: string[] // 'dots' fields whose values are color tokens
  subKey?: string // 'dots' trailing sub-note field
}

const TEXTISH = new Set(['text', 'mono', 'muted', 'faint'])

function fieldTone(rule: ToneRule, v: number): Tone {
  const hit =
    (rule.gt !== undefined && v > rule.gt) ||
    (rule.lt !== undefined && v < rule.lt) ||
    (rule.ge !== undefined && v >= rule.ge) ||
    (rule.le !== undefined && v <= rule.le)
  return hit ? rule.tone : (rule.else ?? 'default')
}

function renderField(col: Column, row: Record<string, unknown>) {
  const raw = row[col.key]
  switch (col.kind) {
    case 'status':
      return (
        <StatusBadge
          status={String(row[col.statusKey ?? 'status'] ?? '')}
          cacheHit={row[col.cacheHitKey ?? 'cacheHit'] as boolean | null}
        />
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

export function DataTable(
  rp: Ctx<{
    rows: Array<Record<string, unknown>>
    columns: Column[]
    rowHrefKey?: string // field holding the row link (e.g. '_href')
    filter?: boolean
    filterKey?: string // field with searchable text (e.g. '_filter')
    filterPlaceholder?: string
    initialSort?: { key: string; desc?: boolean }
    emptyTitle?: string
    emptyHint?: string
    emptyCmd?: string
  }>,
) {
  const p = px(rp)
  const navigate = useNavigate()
  const [sortKey, setSortKey] = createSignal(p.initialSort?.key ?? '')
  const [sortDesc, setSortDesc] = createSignal(p.initialSort?.desc ?? true)
  const [filterText, setFilterText] = createSignal('')

  const rows = createMemo(() => {
    let rs = p.rows ?? []
    const f = filterText().toLowerCase().trim()
    if (f) {
      const fk = p.filterKey
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

  const hrefOf = (row: Record<string, unknown>) => (p.rowHrefKey ? (row[p.rowHrefKey] as string | undefined) : undefined)

  return (
    <div>
      <Show when={p.filter}>
        <div class="px-4 py-2 border-b border-border">
          <input
            type="text"
            placeholder={p.filterPlaceholder ?? 'filter…'}
            value={filterText()}
            onInput={(e) => setFilterText(e.currentTarget.value)}
            class="text-[12px] font-mono w-72"
          />
        </div>
      </Show>
      <Show
        when={rows().length > 0}
        fallback={<EmptyState title={p.emptyTitle ?? 'No data'} hint={p.emptyHint} cmd={p.emptyCmd} />}
      >
        <table class="w-full text-[12px]">
          <thead class="bg-surface-2/40">
            <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
              <For each={p.columns}>
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
                    <For each={p.columns}>
                      {(col) => (
                        <td
                          class="px-4 py-2 font-mono"
                          classList={{ 'text-left': col.align !== 'right', 'text-right': col.align === 'right' }}
                        >
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

export function RankList(
  rp: Ctx<{
    items: Array<Record<string, unknown>>
    labelKey: string
    valueKey: string
    valueFormat?: FormatHint
    indexed?: boolean
    metaKey?: string
    metaPrefix?: string
    metaSuffix?: string
    metaFormat?: FormatHint
    dotsKeys?: string[]
    colorKey?: string // color token field — default '_color'
    fracKey?: string // fraction field (0..1) — default '_frac'
    hrefKey?: string // row link field — default '_href'
    subKey?: string
    emptyTitle?: string
    emptyCmd?: string
  }>,
) {
  const p = px(rp)
  const navigate = useNavigate()
  const meta = (it: Record<string, unknown>) => {
    if (!p.metaKey || it[p.metaKey] === undefined) return undefined
    const v = p.metaFormat ? formatValue(p.metaFormat, Number(it[p.metaKey])) : String(it[p.metaKey])
    return `${p.metaPrefix ?? ''}${v}${p.metaSuffix ?? ''}`
  }
  return (
    <Show
      when={(p.items ?? []).length > 0}
      fallback={<EmptyState title={p.emptyTitle ?? 'Nothing yet'} cmd={p.emptyCmd} />}
    >
      <div class="flex flex-col">
        <For each={p.items}>
          {(it, i) => {
            const href = it[p.hrefKey ?? '_href'] as string | undefined
            const frac = it[p.fracKey ?? '_frac'] as number | undefined
            return (
              <button
                onClick={() => href && navigate(href)}
                class="flex flex-col gap-1 px-4 py-2 text-left border-t border-border first:border-t-0"
                classList={{ 'hover:bg-surface-hover': !!href, 'cursor-default': !href }}
              >
                <div class="flex items-center gap-2 text-[12px] min-w-0">
                  <Show when={p.indexed}>
                    <span class="text-[10px] font-mono text-fg-3 w-4 shrink-0">{i() + 1}.</span>
                  </Show>
                  <For each={(p.dotsKeys ?? []).map((k) => it[k]).filter(Boolean) as string[]}>{(c) => <Dot color={c} />}</For>
                  <span class="font-mono truncate flex-1">{String(it[p.labelKey])}</span>
                  <Show when={p.subKey && it[p.subKey] !== undefined}>
                    <span class="text-fg-3 text-[10px] shrink-0">{String(it[p.subKey!])}</span>
                  </Show>
                  <Show when={meta(it) !== undefined}>
                    <span class="text-fg-3 font-mono text-[10px] shrink-0">{meta(it)}</span>
                  </Show>
                  <span class="font-mono shrink-0">{formatValue(p.valueFormat, Number(it[p.valueKey]))}</span>
                </div>
                <Show when={frac !== undefined}>
                  <HBar fraction={frac!} colorClass={`bg-${it[p.colorKey ?? '_color'] ?? 'accent'}`} />
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

export function LiveActivity(rp: Ctx<{ max?: number }>) {
  const max = px(rp).max ?? 12
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
      setLive((prev) => [{ id: ++seq, kind: ev.kind!, label, t: Date.now() }, ...prev].slice(0, max))
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
