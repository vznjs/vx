import type { Component } from 'solid-js'
import { Show } from 'solid-js'

interface Props {
  label: string
  value: string
  sub?: string
}

export const Card: Component<Props> = (props) => (
  <div class="bg-bg-elevated border border-border rounded-lg px-5 py-4 min-w-40">
    <div class="text-fg-subtle text-xs uppercase tracking-wider">{props.label}</div>
    <div class="text-fg text-2xl font-semibold mt-1 tabular-nums">{props.value}</div>
    <Show when={props.sub}>
      <div class="text-fg-muted text-sm mt-0.5 tabular-nums">{props.sub}</div>
    </Show>
  </div>
)
