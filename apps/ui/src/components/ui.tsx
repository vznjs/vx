// Reusable UI primitives — Card, MetricCard, TrendDelta, EmptyState,
// Skeleton, StatusDot. Tiny and composable.

import { type JSX, Show } from 'solid-js'

export function Card(props: {
  title?: string
  action?: JSX.Element
  children: JSX.Element
  /** Tighten the body padding (lists already pad each row). */
  noPad?: boolean
  class?: string
}) {
  return (
    <div class={`bg-surface border border-border rounded-lg overflow-hidden ${props.class ?? ''}`}>
      <Show when={props.title || props.action}>
        <div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <h2 class="text-xs font-semibold m-0 uppercase tracking-wider text-fg-2">
            {props.title}
          </h2>
          <Show when={props.action}>{props.action}</Show>
        </div>
      </Show>
      <div class={props.noPad ? '' : 'p-4'}>{props.children}</div>
    </div>
  )
}

export function MetricCard(props: {
  label: string
  value: string
  sub?: string
  delta?: number | undefined
  /** Optional inline chart (Sparkline/etc) under the value. */
  chart?: JSX.Element
  tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const tone = () => props.tone ?? 'default'
  const borderTone = () =>
    tone() === 'good'
      ? 'border-success/40 bg-success/[0.04]'
      : tone() === 'warn'
        ? 'border-warn/40 bg-warn/[0.04]'
        : tone() === 'bad'
          ? 'border-danger/40 bg-danger/[0.04]'
          : 'border-border bg-surface'
  return (
    <div class={`rounded-lg border px-4 py-3 ${borderTone()}`}>
      <div class="flex items-center justify-between gap-2">
        <div class="text-[10px] uppercase tracking-wider text-fg-3 font-semibold">
          {props.label}
        </div>
        <Show when={props.delta !== undefined}>
          <TrendDelta value={props.delta!} />
        </Show>
      </div>
      <div class="text-xl font-mono mt-1.5 text-fg leading-tight">{props.value}</div>
      <Show when={props.sub}>
        <div class="text-[11px] text-fg-3 mt-0.5">{props.sub}</div>
      </Show>
      <Show when={props.chart}>
        <div class="mt-2 -mx-1">{props.chart}</div>
      </Show>
    </div>
  )
}

export function TrendDelta(props: { value: number; goodIsUp?: boolean }) {
  const goodIsUp = () => props.goodIsUp ?? true
  const isUp = () => props.value > 0
  const isFlat = () => Math.abs(props.value) < 0.005
  const tone = () => {
    if (isFlat()) return 'text-fg-3'
    return (isUp() === goodIsUp()) ? 'text-success' : 'text-danger'
  }
  const arrow = () => (isFlat() ? '·' : isUp() ? '▲' : '▼')
  return (
    <span class={`text-[10px] font-mono ${tone()}`}>
      {arrow()} {Math.abs(props.value * 100).toFixed(0)}%
    </span>
  )
}

export function EmptyState(props: { title: string; hint?: string; cmd?: string }) {
  return (
    <div class="px-4 py-12 text-center">
      <div class="text-fg-1 text-sm font-medium">{props.title}</div>
      <Show when={props.hint}>
        <div class="text-fg-3 text-xs mt-1">{props.hint}</div>
      </Show>
      <Show when={props.cmd}>
        <code class="inline-block mt-3 px-2 py-1 bg-surface-2 border border-border rounded text-[11px] font-mono text-fg-1">
          {props.cmd}
        </code>
      </Show>
    </div>
  )
}

export function Skeleton(props: { class?: string }) {
  return (
    <div
      class={`bg-surface-2 rounded animate-pulse ${props.class ?? 'h-4 w-full'}`}
      aria-busy="true"
    />
  )
}

export function StatusDot(props: { ok: boolean; label?: string }) {
  return (
    <span class="inline-flex items-center gap-1.5 text-[11px] text-fg-2 font-mono">
      <span
        class={`inline-block w-1.5 h-1.5 rounded-full ${props.ok ? 'bg-success' : 'bg-danger'}`}
        style={props.ok ? { 'box-shadow': '0 0 6px var(--success)' } : {}}
      />
      <Show when={props.label}>{props.label}</Show>
    </span>
  )
}

export function StatusBadge(props: { status: string; cacheHit?: boolean | null }) {
  const tone = () => {
    if (props.status === 'failed') return 'text-danger bg-danger/10 border-danger/30'
    if (props.cacheHit) return 'text-cache-local bg-cache-local/10 border-cache-local/30'
    if (props.status === 'success') return 'text-success bg-success/10 border-success/30'
    if (props.status === 'skipped') return 'text-warn bg-warn/10 border-warn/30'
    return 'text-fg-2 bg-surface-2 border-border'
  }
  return (
    <span class={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${tone()}`}>
      {props.status}
    </span>
  )
}
