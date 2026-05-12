import type { JSX, Resource } from 'solid-js'
import { Show } from 'solid-js'

interface Props<T> {
  resource: Resource<T>
  children: (data: T) => JSX.Element
}

export function AsyncView<T>(props: Props<T>): JSX.Element {
  return (
    <Show
      when={!props.resource.loading && !props.resource.error && props.resource()}
      fallback={
        <Show when={props.resource.error} fallback={<div class="text-fg-muted py-8">loading…</div>}>
          <div class="text-err py-8 font-mono text-sm">{String(props.resource.error)}</div>
        </Show>
      }
    >
      {(data) => props.children(data())}
    </Show>
  )
}
