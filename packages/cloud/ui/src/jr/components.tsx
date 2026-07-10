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

import { For, Show, type JSX, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import { type BaseComponentProps, useStateBinding } from '@json-render/solid'
import { A, useNavigate } from '@solidjs/router'
import {
  type RunSummaryRow,
  type TaskLogResponse,
  downloadArtifact,
  getGraph,
  getTaskLog,
  subscribeEvents,
} from '../api.ts'
import { HBar, Heatmap as HeatmapPrimitive, LineChart as LineChartPrimitive, Treemap as TreemapPrimitive } from '../components/charts.tsx'
import { Card as UiCard, EmptyState, LoadError, MetricCard, SegmentedToggle, SkeletonRows, StatusBadge } from '../components/ui.tsx'
import { Flamegraph as FlamegraphPrimitive, flameEdgesOf } from '../components/Flamegraph.tsx'
import { criticalPath } from '../components/critical-path.ts'
import { RunGraph as RunGraphPrimitive, type RunGraphNode } from '../components/RunGraph.tsx'
import { STATUS, toVizState, type VizState } from '../components/status.tsx'
import { cpuPct, formatDuration, formatHour, paletteFor } from '../format.ts'
import { type FormatHint, type Tone, axisFormatter, formatValue, toneText } from './hints.ts'
import type { Recommendation } from './functions.ts'

type Row = Record<string, unknown>
type C<P> = BaseComponentProps<P>
const enc = encodeURIComponent

/** Loader-computed availability of one data source (`/<key>Status` in state). */
type DataStatus = 'loading' | 'error' | 'missing' | 'ok'

/** Replace `{field}` in a template with the URL-encoded row value (for hrefs). */
function interpolate(tpl: string, row: Row): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, f) => enc(String(row[f] ?? '')))
}
/** Like `interpolate`, but undefined when any field is empty — a link column
 *  over best-effort data (artifact provenance) degrades to '—', never a
 *  half-built href. */
function interpolateHref(tpl: string, row: Row): string | undefined {
  let missing = false
  const href = tpl.replace(/\{(\w+)\}/g, (_m, f) => {
    const v = row[f]
    if (v === undefined || v === null || v === '') missing = true
    return enc(String(v ?? ''))
  })
  return missing ? undefined : href
}
/** Replace `{field}` with the raw row value (for display labels). */
function interpolateRaw(tpl: string, row: Row): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, f) => String(row[f] ?? ''))
}

type DotMap = 'palette' | 'failureMode' | 'delta' | 'keyChanged'
function colorOf(map: DotMap, v: unknown): string {
  if (map === 'failureMode') return v === 'stable' ? 'success' : v === 'flaky-recoverable' ? 'warn' : 'danger'
  // Semantic delta colors — faster is GOOD (green), slower BAD (red); a
  // hash-palette here made slower/faster arbitrary, unstable colors.
  if (map === 'delta') return v === 'faster' ? 'success' : v === 'slower' ? 'danger' : v === 'new' ? 'accent' : v === 'gone' ? 'warn' : 'faint'
  if (map === 'keyChanged') return v === 'changed' ? 'warn' : 'faint'
  return paletteFor(String(v))
}

// Token → LITERAL class maps. UnoCSS's static extractor only sees literal
// strings in scanned files — `bg-${x}` interpolations silently drop from the
// build the moment a token leaves the safelist (the house gotcha).
const DOT_BG: Record<string, string> = {
  'chart-1': 'bg-chart-1', 'chart-2': 'bg-chart-2', 'chart-3': 'bg-chart-3', 'chart-4': 'bg-chart-4',
  'chart-5': 'bg-chart-5', 'chart-6': 'bg-chart-6', 'chart-7': 'bg-chart-7', 'chart-8': 'bg-chart-8',
  success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger', accent: 'bg-accent',
  'accent-2': 'bg-accent-2', 'cache-local': 'bg-cache-local', 'cache-remote': 'bg-cache-remote',
  info: 'bg-info', faint: 'bg-fg-3',
}
const FILL_CLASS: Record<string, string> = {
  'chart-1': 'fill-chart-1', 'chart-2': 'fill-chart-2', 'chart-3': 'fill-chart-3', 'chart-4': 'fill-chart-4',
  'chart-5': 'fill-chart-5', 'chart-6': 'fill-chart-6', 'chart-7': 'fill-chart-7', 'chart-8': 'fill-chart-8',
}
const barBg = (token: string): string => DOT_BG[token] ?? 'bg-accent'

function Dot(props: { color: string }) {
  return <span class={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${DOT_BG[props.color] ?? 'bg-fg-3'}`} />
}

/**
 * Shared loading / error affordance for data-bound components. Views thread
 * `"status": { "$state": "/<key>Status" }`; loading renders pulse placeholders,
 * a failed fetch renders an inline banner instead of a misleading empty state.
 */
function DataGate(props: { status?: DataStatus; skeleton: JSX.Element; children: JSX.Element }) {
  return (
    <Show when={props.status !== 'loading'} fallback={props.skeleton}>
      <Show when={props.status !== 'error'} fallback={<LoadError />}>
        {props.children}
      </Show>
    </Show>
  )
}

function ChartSkeleton(props: { height?: number }) {
  return <div class="bg-surface-2 rounded-lg animate-pulse w-full" style={{ height: `${props.height ?? 200}px` }} aria-busy="true" />
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
            <span class={`inline-block w-2 h-2 rounded-full ${DOT_BG[c.props.dotColor!] ?? 'bg-accent'}`} />
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

export function Metric(c: C<{ label: string; value: string; sub?: string; tone?: 'default' | 'good' | 'warn' | 'bad' }>) {
  return <MetricCard label={c.props.label} value={c.props.value} sub={c.props.sub} tone={c.props.tone} />
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
export function LineChart(c: C<{ rows: Row[]; xKey?: string; reverse?: boolean; series: ChartSeries[]; xFormat?: FormatHint; yFormat?: FormatHint; height?: number; yMin?: number; status?: DataStatus }>) {
  const rows = () => {
    const rs = c.props.rows ?? []
    return c.props.reverse ? [...rs].reverse() : rs
  }
  const xs = () => (c.props.xKey ? rows().map((r) => Number(r[c.props.xKey!])) : rows().map((_, i) => i))
  const series = () => (c.props.series ?? []).map((s) => ({ name: s.name, strokeClass: s.strokeClass, areaClass: s.areaClass, data: rows().map((r) => Number(r[s.yKey])) }))
  return (
    <DataGate status={c.props.status} skeleton={<ChartSkeleton height={c.props.height} />}>
      <Show when={rows().length > 0} fallback={<EmptyState title="No data yet" />}>
        <LineChartPrimitive xs={xs()} series={series()} formatX={axisFormatter(c.props.xFormat)} formatY={axisFormatter(c.props.yFormat)} height={c.props.height} yMin={c.props.yMin} />
      </Show>
    </DataGate>
  )
}

export function Treemap(c: C<{ rows: Row[]; labelKey: string; valueKey: string; colorFrom?: string; valueFormat?: FormatHint; height?: number; status?: DataStatus }>) {
  const data = () =>
    (c.props.rows ?? [])
      .filter((r) => Number(r[c.props.valueKey]) > 0)
      .map((r) => ({ label: String(r[c.props.labelKey]), value: Number(r[c.props.valueKey]), colorClass: FILL_CLASS[paletteFor(String(r[c.props.colorFrom ?? c.props.labelKey]))] ?? 'fill-chart-1' }))
  return (
    <DataGate status={c.props.status} skeleton={<ChartSkeleton height={c.props.height} />}>
      <Show when={data().length > 0} fallback={<EmptyState title="No cached output yet" />}>
        <TreemapPrimitive data={data()} height={c.props.height} format={(v) => formatValue(c.props.valueFormat, v)} />
      </Show>
    </DataGate>
  )
}

export function Heatmap(c: C<{ rows: Row[]; dayKey?: string; hourKey?: string; valueKey: string; cellSize?: number; valueFormat?: FormatHint; status?: DataStatus }>) {
  const data = () =>
    (c.props.rows ?? []).map((r) => ({ dayOfWeek: Number(r[c.props.dayKey ?? 'dayOfWeek']), hourOfDay: Number(r[c.props.hourKey ?? 'hourOfDay']), value: Number(r[c.props.valueKey]) }))
  return (
    <DataGate status={c.props.status} skeleton={<ChartSkeleton height={180} />}>
      <Show when={data().some((cell) => cell.value > 0)} fallback={<EmptyState title="No runs in the window" />}>
        <HeatmapPrimitive data={data()} cellSize={c.props.cellSize} format={(v) => (c.props.valueFormat ? formatValue(c.props.valueFormat, v) : `${v} runs`)} />
      </Show>
    </DataGate>
  )
}

// Two views of a RECORDED run, switchable: GRAPH (dependency structure — the
// DAG rebuilt from the workspace via /v1/graph, with recorded status/CPU/RAM
// overlaid) and FLAME (by ACTUAL time — bars positioned by each task's real
// start/end, so overlap = real concurrency, NOT the dependency layout). Both
// write the clicked task to `/selectedTask` (the Facts panel binding). The
// graph view needs a colocated workspace (a local `vx-cloud serve`); the flame
// view works from recorded timings alone, so it's always available.
export function RunViz(c: C<{ rows: readonly RunSummaryRow[]; selectKey?: string }>) {
  const [view, setView] = createSignal<'graph' | 'flame'>('graph')
  // Track an explicit user choice so the hosted auto-fallback (below) never
  // fights the toggle.
  let userChose = false
  const [selected, setSelected] = useStateBinding<RunSummaryRow>(c.props.selectKey ?? '/selectedTask')
  const rows = (): readonly RunSummaryRow[] => c.props.rows ?? []
  const rowById = createMemo(() => {
    const m = new Map<string, RunSummaryRow>()
    for (const r of rows()) m.set(`${r.project}#${r.task}`, r)
    return m
  })
  // Refetch the graph whenever the recorded task set changes (by id).
  const specs = createMemo(() => Array.from(rowById().keys()))
  const [graph] = createResource(specs, async (s) => {
    if (s.length === 0) return []
    try {
      return await getGraph(s)
    } catch {
      return []
    }
  })
  const nodes = createMemo<RunGraphNode[]>(() =>
    (graph() ?? []).map((g) => ({ id: g.id, project: g.project, task: g.task, isGroup: g.isGroup, deps: g.deps })),
  )
  // The graph view needs a colocated workspace; on a hosted serve the fetch
  // resolves empty — default to the flame (always available from recorded
  // timings) instead of opening on "Graph unavailable".
  createEffect(() => {
    if (!graph.loading && nodes().length === 0 && !userChose && specs().length > 0) setView('flame')
  })
  const flameEdges = createMemo(() => flameEdgesOf(nodes()))
  // Critical path over RECORDED durations — same wall-time-floor story the
  // live cockpit shows. Cache hits restore ahead of their deps (two-tier
  // scheduler), so they're dependency-independent for the chain. Without dep
  // edges (hosted) this degrades to the longest single task.
  const critical = createMemo(() => {
    const ns = nodes().length > 0 ? nodes() : specs().map((id) => ({ id, deps: [] as string[] }))
    const durationOf = (id: string) => rowById().get(id)?.durationMs ?? 0
    const restoresAhead = (id: string) => {
      const r = rowById().get(id)
      return r !== undefined && (r.cacheHit === true || r.status === 'cache-hit' || r.status === 'cache-hit-remote')
    }
    return criticalPath(ns, durationOf, restoresAhead)
  })
  const criticalSet = createMemo(() => new Set(critical().chain))
  const stateOf = (id: string): VizState => {
    const r = rowById().get(id)
    return r ? toVizState(r.status, r.cacheHit === true) : 'queued'
  }
  const selectedId = () => {
    const s = selected()
    return s ? `${s.project}#${s.task}` : undefined
  }
  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2.5">
        <SegmentedToggle
          options={['graph', 'flame'] as const}
          value={view()}
          onChange={(v) => {
            userChose = true
            setView(v)
          }}
        />
        <span class="text-[11px] text-fg-3">
          {view() === 'graph' ? 'dependency structure' : 'by actual time — overlap is real concurrency'}
        </span>
        <Show when={critical().chain.length > 1}>
          <span class="ml-auto inline-flex items-center gap-1 text-[11px] font-mono text-warn tabular-nums" title="critical path — the wall-time floor">
            <span class="i-tabler-flame" aria-hidden="true" />
            {critical().chain.length} tasks · {formatDuration(critical().totalMs)} floor
          </span>
        </Show>
      </div>
      <div class="h-[460px] w-full">
        <Show when={view() === 'flame'}>
          <div class="h-full p-1">
            <Show when={rows().length > 0} fallback={<EmptyState title="No tasks" />}>
              <FlamegraphPrimitive tasks={rows()} selectedId={selectedId()} highlightIds={criticalSet()} edges={flameEdges()} onSelect={(t) => setSelected(t)} />
            </Show>
          </div>
        </Show>
        <Show when={view() === 'graph'}>
          <Show when={!graph.loading} fallback={<div class="p-6 text-fg-3 text-sm">Resolving graph…</div>}>
            <Show
              when={nodes().length > 0}
              fallback={
                <EmptyState
                  title="Graph unavailable on this serve"
                  hint="The dependency graph is rebuilt from a colocated workspace — start vx-cloud serve in the project. The Flame view works from recorded timings."
                />
              }
            >
              <RunGraphPrimitive
                nodes={nodes()}
                stateOf={stateOf}
                statsOf={(id) => {
                  const r = rowById().get(id)
                  return {
                    durationMs: r?.durationMs,
                    cpuMs: r?.cpuMs ?? undefined,
                    peakRssBytes: r?.peakRssBytes ?? undefined,
                  }
                }}
                selectedId={selectedId()}
                highlightIds={criticalSet()}
                onSelect={(id) => {
                  const r = rowById().get(id)
                  if (r) setSelected(r)
                }}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

// --- DataTable --------------------------------------------------------------

type CellKind = 'text' | 'mono' | 'muted' | 'faint' | FormatHint | 'cpuPct' | 'status' | 'cache' | 'projtask' | 'bar' | 'dots' | 'shorthash' | 'link' | 'download'
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
  dots?: Array<{ field: string; map: DotMap }>
  projectKey?: string
  taskKey?: string
  nKey?: string
  statusKey?: string
  cacheHitKey?: string
  cpuKey?: string
  durKey?: string
  hitKey?: string
  len?: number // shorthash length
  href?: string // kind:'link' — href template, e.g. /compare/{runId}
  linkLabel?: string // kind:'link' — cell text; {field} templates allowed
}
const TEXTISH = new Set(['text', 'mono', 'muted', 'faint'])

// Cache-provenance cell — same vocabulary as status.tsx (local ≠ remote).
// Literal classes for UnoCSS.
const CACHE_CELL: Record<string, { label: string; cls: string }> = {
  'cache-hit': { label: 'local', cls: 'text-cache-local' },
  'cache-hit-remote': { label: 'remote', cls: 'text-cache-remote' },
}

function fieldTone(rule: ToneRule, v: number): Tone {
  const hit = (rule.gt !== undefined && v > rule.gt) || (rule.lt !== undefined && v < rule.lt) || (rule.ge !== undefined && v >= rule.ge) || (rule.le !== undefined && v <= rule.le)
  return hit ? rule.tone : (rule.else ?? 'default')
}

function renderField(col: Column, row: Row, max: number) {
  switch (col.kind) {
    case 'status': {
      const status = row[col.statusKey ?? 'status']
      if (status === null || status === undefined || status === '') return <span class="text-fg-3">—</span>
      return <StatusBadge status={String(status)} cacheHit={row[col.cacheHitKey ?? 'cacheHit'] as boolean | null} />
    }
    case 'cache': {
      const status = String(row[col.statusKey ?? 'status'] ?? '')
      const hit = row[col.cacheHitKey ?? 'cacheHit'] === true
      const cell = CACHE_CELL[status] ?? (hit ? CACHE_CELL['cache-hit'] : undefined)
      return cell ? <span class={cell.cls}>{cell.label}</span> : <span class="text-fg-3">miss</span>
    }
    case 'link': {
      const href = col.href ? interpolateHref(col.href, row) : undefined
      if (!href) return <span class="text-fg-3">—</span>
      const label = col.linkLabel ? interpolateRaw(col.linkLabel, row) : 'view'
      return (
        <A href={href} class="text-accent hover:underline text-[11px]" onClick={(e) => e.stopPropagation()}>
          {label}
        </A>
      )
    }
    case 'download': {
      const hash = row[col.key]
      if (hash === undefined || hash === null || hash === '') return <span class="text-fg-3">—</span>
      return (
        <button
          type="button"
          class="text-accent hover:underline text-[11px] font-mono bg-transparent border-0 cursor-pointer p-0"
          title="Download the artifact (tar.zst)"
          onClick={(e) => {
            e.stopPropagation()
            void downloadArtifact(String(hash))
          }}
        >
          ↓ download
        </button>
      )
    }
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
            <HBar fraction={max > 0 ? v / max : 0} colorClass={barBg(color)} />
          </div>
        </div>
      )
    }
    case 'cpuPct': {
      const pct = cpuPct(
        row[col.cpuKey ?? 'cpuMs'] as number | null | undefined,
        Number(row[col.durKey ?? 'durationMs']),
        row[col.hitKey ?? 'cacheHit'] as boolean | null,
      )
      const tone: Tone = pct !== undefined && pct > 100 ? 'success' : 'faint'
      return <span class={toneText(tone)}>{pct !== undefined ? `${pct}%` : '—'}</span>
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
    status?: DataStatus // loading → skeleton rows, error → inline banner
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
      <DataGate status={c.props.status} skeleton={<SkeletonRows rows={5} />}>
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
      </DataGate>
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
    dots?: Array<{ field: string; map: DotMap }>
    barFrom?: string // value field → fraction (max computed internally)
    colorFrom?: string // bar color via paletteFor(item[colorFrom])
    rowHref?: string
    rowTaskRef?: { projectKey?: string; taskKey?: string }
    subKey?: string
    limit?: number
    emptyTitle?: string
    emptyCmd?: string
    status?: DataStatus // loading → skeleton rows, error → inline banner
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
    <DataGate status={c.props.status} skeleton={<SkeletonRows rows={4} />}>
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
                  <HBar fraction={Number(it[c.props.barFrom!]) / max()} colorClass={barBg(c.props.colorFrom ? paletteFor(String(it[c.props.colorFrom])) : 'accent')} />
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </Show>
    </DataGate>
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
              {/* Same dot colors as the shared STATUS vocabulary (status.tsx). */}
              <span class={`truncate ${e.kind === 'task:complete' && e.label.startsWith('✗') ? STATUS.failed.dot : e.kind === 'task:complete' ? STATUS.success.dot : e.kind.startsWith('run:') ? 'text-fg-3' : 'text-fg-1'}`}>{e.label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/**
 * The persisted terminal output for the selected task. Self-contained (its own
 * createResource keyed on runId + project#task) because a json-render data
 * source loads once per page and can't refetch when `/selectedTask` changes.
 * 404 → an honest "no logs captured" (a pre-feature run, a cache-hit whose
 * producing run aged out, or a skipped task).
 */
export function TaskLogs(c: C<{ runId?: string; project?: string; task?: string }>) {
  const taskId = () =>
    c.props.project && c.props.task ? `${c.props.project}#${c.props.task}` : undefined
  const [log] = createResource(
    () => {
      const id = taskId()
      return c.props.runId && id ? ([c.props.runId, id] as const) : undefined
    },
    ([runId, id]) => getTaskLog(runId, id),
  )

  return (
    <Show
      when={!log.loading}
      fallback={<div class="text-fg-3 text-xs py-4">Loading logs…</div>}
    >
      <Show
        when={log() as TaskLogResponse | null}
        fallback={<div class="text-fg-3 text-xs py-4">No logs captured for this task.</div>}
      >
        {(data) => (
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2 text-[10px] text-fg-3 font-mono">
              <span class={data().status === 'failed' ? STATUS.failed.dot : STATUS.success.dot}>
                {data().status}
              </span>
              <Show when={data().source === 'cache'}>
                <span>
                  · output captured on run{' '}
                  <A href={`/runs/${data().refRunId}`} class="text-accent no-underline hover:underline">
                    {(data().refRunId ?? '').slice(0, 8)}
                  </A>{' '}
                  (this task was a cache hit)
                </span>
              </Show>
              <Show when={data().artifactHash}>
                <button
                  type="button"
                  class="ml-auto text-accent hover:underline bg-transparent border-0 cursor-pointer p-0 font-mono text-[10px]"
                  onClick={() => void downloadArtifact(data().artifactHash!)}
                >
                  ↓ download artifact
                </button>
              </Show>
            </div>
            <Show when={data().truncatedHeadChars > 0}>
              <div class="text-[10px] text-warn font-mono">
                … earlier output truncated ({Math.round(data().truncatedHeadChars / 1024)} KiB dropped)
              </div>
            </Show>
            <pre class="bg-bg-1 border border-border-1 rounded-md p-3 text-[11px] font-mono overflow-auto max-h-[420px] whitespace-pre-wrap m-0">
              {data().content.replace(ANSI, '') || '— no output —'}
            </pre>
          </div>
        )}
      </Show>
    </Show>
  )
}

/** Pretty-printed JSON block — the resolved-config payloads on entity pages. */
export function Json(c: C<{ value?: unknown; maxHeight?: number }>) {
  const text = () => {
    try {
      return JSON.stringify(c.props.value, null, 2) ?? '—'
    } catch {
      return String(c.props.value)
    }
  }
  return (
    <pre
      class="m-0 p-3 rounded-md border border-border bg-surface-2/50 text-[11px] font-mono overflow-auto whitespace-pre-wrap text-fg-1"
      style={{ 'max-height': `${c.props.maxHeight ?? 360}px` }}
    >
      {text()}
    </pre>
  )
}

/**
 * The resolved per-task config blocks on a project's entity page: one block
 * per task in the catalog's `config.tasks`, its name linking to the task's
 * entity page. Fed by the `catalogProject` source (the `vx show` payload).
 */
export function TaskConfigList(c: C<{ config?: unknown; project?: string }>) {
  const entries = createMemo<Array<[string, unknown]>>(() => {
    const cfg = c.props.config
    const tasks = cfg && typeof cfg === 'object' ? (cfg as Row).tasks : undefined
    return tasks && typeof tasks === 'object' ? Object.entries(tasks as Record<string, unknown>) : []
  })
  return (
    <Show when={entries().length > 0} fallback={<EmptyState title="No tasks in this config" />}>
      <div class="flex flex-col gap-3">
        <For each={entries()}>
          {([name, cfg]) => (
            <div class="rounded-lg border border-border overflow-hidden">
              <div class="px-3 py-2 bg-surface-2/40 border-b border-border">
                <A
                  href={`/tasks/${enc(`${c.props.project ?? ''}#${name}`)}`}
                  class="font-mono text-[12px] text-accent no-underline hover:underline"
                >
                  {name}
                </A>
              </div>
              <pre class="m-0 p-3 text-[11px] font-mono overflow-auto max-h-[280px] whitespace-pre-wrap text-fg-1">
                {JSON.stringify(cfg, null, 2)}
              </pre>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/**
 * A download action for one stored artifact, shown only when the store actually
 * holds the hash (probed via the /v1/artifacts list the page already fetched
 * — no extra endpoint). `fallbackText` renders an honest absence note where
 * a silent nothing would read as broken (the cache-entry page).
 */
export function ArtifactDownload(c: C<{ hash?: string; artifacts?: Row[]; fallbackText?: string }>) {
  const available = () => {
    const h = c.props.hash
    return typeof h === 'string' && h !== '' && (c.props.artifacts ?? []).some((a) => a.hash === h)
  }
  return (
    <Show
      when={available()}
      fallback={
        <Show when={c.props.fallbackText}>
          <div class="text-fg-3 text-[11px]">{c.props.fallbackText}</div>
        </Show>
      }
    >
      <button
        type="button"
        class="inline-flex items-center gap-1.5 text-[11px] font-mono text-accent border border-accent/40 rounded px-2.5 py-1 hover:bg-accent/10 transition-colors bg-transparent cursor-pointer"
        onClick={() => void downloadArtifact(c.props.hash!)}
      >
        <span class="i-tabler-download text-[13px]" aria-hidden="true" />
        download artifact
      </button>
    </Show>
  )
}

// --- RecList ----------------------------------------------------------------

// Per-kind tone + icon (literal classes for UnoCSS; the /40 + /5 opacity
// variants are in the safelist, and these live in a scanned .tsx anyway).
const REC_TONE: Record<string, { border: string; bg: string; text: string; icon: string }> = {
  'flaky-retries': { border: 'border-warn/40', bg: 'bg-warn/5', text: 'text-warn', icon: 'i-tabler-refresh' },
  'flaky-persistent': { border: 'border-danger/40', bg: 'bg-danger/5', text: 'text-danger', icon: 'i-tabler-alert-triangle' },
  'non-hermetic': { border: 'border-danger/40', bg: 'bg-danger/5', text: 'text-danger', icon: 'i-tabler-versions' },
  uncached: { border: 'border-accent/40', bg: 'bg-accent/5', text: 'text-accent', icon: 'i-tabler-database' },
}
const REC_TONE_DEFAULT = { border: 'border-border', bg: 'bg-surface-2/40', text: 'text-fg-1', icon: 'i-tabler-info-circle' }

/**
 * The actionable-recommendations list for a task (task-detail): every
 * applicable fix as a short rationale + a copy-able config snippet. Empty →
 * a positive "looks healthy" note. Fed by the `taskRecommendations` source
 * (a `{ kind, title, detail, snippet? }[]`).
 */
export function RecList(c: C<{ items?: Recommendation[]; emptyTitle?: string; status?: DataStatus }>) {
  const items = () => c.props.items ?? []
  return (
    <DataGate status={c.props.status} skeleton={<SkeletonRows rows={2} />}>
      <Show
        when={items().length > 0}
        fallback={
          <div class="flex items-center gap-2 px-4 py-4 text-[12px] text-success">
            <span class="i-tabler-circle-check text-[14px]" aria-hidden="true" />
            {c.props.emptyTitle ?? 'Looks healthy — no recommendations ✓'}
          </div>
        }
      >
        <div class="flex flex-col gap-3 p-4">
          <For each={items()}>
            {(r) => {
              const tone = REC_TONE[r.kind] ?? REC_TONE_DEFAULT
              return (
                <div class={`rounded-lg border ${tone.border} ${tone.bg} px-3.5 py-3 flex flex-col gap-2`}>
                  <div class="flex items-center gap-2">
                    <span class={`${tone.icon} ${tone.text} text-[14px] shrink-0`} aria-hidden="true" />
                    <span class={`text-[12px] font-semibold ${tone.text}`}>{r.title}</span>
                  </div>
                  <div class="text-[11px] text-fg-2 leading-relaxed">{r.detail}</div>
                  <Show when={r.snippet}>
                    <pre class="m-0 px-3 py-2 rounded-md border border-border bg-bg/60 text-[11px] font-mono overflow-auto whitespace-pre-wrap text-fg-1">
                      {r.snippet}
                    </pre>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </DataGate>
  )
}
