// Reusable UI primitives — Card, MetricCard, TrendDelta, EmptyState,
// Skeleton, StatusDot, StatusBadge. Tiny and composable; styled for a modern
// dark dashboard (soft borders, subtle shadows, rounded corners, pill badges).

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
    <div
      class={`bg-surface/80 border border-border rounded-xl overflow-hidden shadow-card backdrop-blur-sm transition-colors hover:border-border-strong ${props.class ?? ''}`}
    >
      <Show when={props.title || props.action}>
        <div class="flex items-center justify-between px-4 py-3 border-b border-border/70">
          <h2 class="text-[11px] font-semibold m-0 uppercase tracking-[0.08em] text-fg-2">
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
  const toneRing = () =>
    tone() === 'good'
      ? 'border-success/30 bg-gradient-to-b from-success/[0.07] to-transparent'
      : tone() === 'warn'
        ? 'border-warn/30 bg-gradient-to-b from-warn/[0.07] to-transparent'
        : tone() === 'bad'
          ? 'border-danger/30 bg-gradient-to-b from-danger/[0.07] to-transparent'
          : 'border-border bg-surface/70'
  const valueTone = () =>
    tone() === 'good' ? 'text-success' : tone() === 'warn' ? 'text-warn' : tone() === 'bad' ? 'text-danger' : 'text-fg'
  return (
    <div class={`rounded-xl border px-4 py-3.5 shadow-card transition-colors hover:border-border-strong ${toneRing()}`}>
      <div class="flex items-center justify-between gap-2">
        <div class="text-[10px] uppercase tracking-[0.08em] text-fg-3 font-semibold">{props.label}</div>
        <Show when={props.delta !== undefined}>
          <TrendDelta value={props.delta!} />
        </Show>
      </div>
      <div class={`text-2xl font-mono font-medium mt-2 leading-none tabular-nums ${valueTone()}`}>{props.value}</div>
      <Show when={props.sub}>
        <div class="text-[11px] text-fg-3 mt-1.5">{props.sub}</div>
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
    return isUp() === goodIsUp() ? 'text-success' : 'text-danger'
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
        <code class="inline-block mt-3 px-2.5 py-1.5 bg-surface-2 border border-border rounded-lg text-[11px] font-mono text-fg-1">
          {props.cmd}
        </code>
      </Show>
    </div>
  )
}

export function Skeleton(props: { class?: string }) {
  return <div class={`bg-surface-2 rounded-lg animate-pulse ${props.class ?? 'h-4 w-full'}`} aria-busy="true" />
}

export function StatusDot(props: { ok: boolean; label?: string }) {
  return (
    <span class="inline-flex items-center gap-1.5 text-[11px] text-fg-2 font-mono">
      <span
        class={`inline-block w-1.5 h-1.5 rounded-full ${props.ok ? 'bg-success' : 'bg-danger'}`}
        style={props.ok ? { 'box-shadow': '0 0 7px rgb(var(--success))' } : { 'box-shadow': '0 0 7px rgb(var(--danger))' }}
      />
      <Show when={props.label}>{props.label}</Show>
    </span>
  )
}

export function StatusBadge(props: { status: string; cacheHit?: boolean | null }) {
  const tone = () => {
    if (props.status === 'failed') return 'text-danger bg-danger/10 border-danger/25'
    if (props.cacheHit) return 'text-cache-local bg-cache-local/10 border-cache-local/25'
    if (props.status === 'success') return 'text-success bg-success/10 border-success/25'
    if (props.status === 'running') return 'text-accent bg-accent/10 border-accent/25'
    if (props.status === 'skipped') return 'text-warn bg-warn/10 border-warn/25'
    return 'text-fg-2 bg-surface-2 border-border'
  }
  return (
    <span class={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider border ${tone()}`}>
      {props.status}
    </span>
  )
}
