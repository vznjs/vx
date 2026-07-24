// Reusable UI primitives — Card, MetricCard, EmptyState, Skeleton,
// SkeletonRows, LoadError, SegmentedToggle, StatusDot, StatusBadge. Tiny and
// composable; styled for a modern dark dashboard (soft borders, subtle
// shadows, rounded corners, pill badges).

import { For, type JSX, Show } from 'solid-js'
import { STATUS, toVizState } from './status.tsx'

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
      class={`bg-surface/95 border border-border rounded-xl overflow-hidden shadow-card transition-colors hover:border-border-strong ${props.class ?? ''}`}
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
      <div class="text-[10px] uppercase tracking-[0.08em] text-fg-3 font-semibold">{props.label}</div>
      <div class={`text-2xl font-mono font-medium mt-2 leading-none tabular-nums ${valueTone()}`}>{props.value}</div>
      <Show when={props.sub}>
        <div class="text-[11px] text-fg-3 mt-1.5">{props.sub}</div>
      </Show>
    </div>
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

/** Pulse placeholder rows for a loading table/list. */
export function SkeletonRows(props: { rows?: number }) {
  return (
    <div class="px-4 py-3 flex flex-col gap-2.5" aria-busy="true">
      <For each={Array.from({ length: props.rows ?? 4 })}>
        {(_, i) => <Skeleton class={`h-3.5 ${i() % 2 === 0 ? 'w-full' : 'w-4/5'}`} />}
      </For>
    </div>
  )
}

/** Inline banner for a failed data fetch — the section stays visible + honest. */
export function LoadError(props: { hint?: string }) {
  return (
    <div class="mx-4 my-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-fg-2">
      <span class="i-tabler-plug-connected-x text-danger shrink-0" aria-hidden="true" />
      <span>{props.hint ?? 'Failed to load — check the serve connection, then reload.'}</span>
    </div>
  )
}

/** The Graph/Flame-style segmented switch, shared by cockpit + run detail. */
export function SegmentedToggle<T extends string>(props: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  labels?: Partial<Record<T, string>>
}) {
  return (
    <div class="flex items-center gap-0.5 shrink-0 rounded-lg border border-border bg-surface-2/50 p-0.5 text-[12px]">
      <For each={props.options}>
        {(v) => (
          <button
            onClick={() => props.onChange(v)}
            class="px-3 py-1 rounded-md transition capitalize"
            classList={{ 'bg-surface-hover text-fg': props.value === v, 'text-fg-3 hover:text-fg-2': props.value !== v }}
          >
            {props.labels?.[v] ?? v}
          </button>
        )}
      </For>
    </div>
  )
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

/**
 * Thin view over the shared status vocabulary (status.tsx) — same label /
 * icon / colors as the graph, flame and cockpit, so tables can't drift.
 * Preserves the local vs remote cache-hit distinction.
 */
export function StatusBadge(props: { status: string; cacheHit?: boolean | null }) {
  const viz = () => STATUS[toVizState(props.status, props.cacheHit === true)]
  return (
    <span class={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider border ${viz().pill}`}>
      <span class={`${viz().icon} text-[11px]`} aria-hidden="true" />
      {viz().label}
    </span>
  )
}
