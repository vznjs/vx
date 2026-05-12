import type { JSX, Component } from 'solid-js'

interface Props {
  children: JSX.Element
}

export const Empty: Component<Props> = (props) => (
  <div class="text-fg-muted bg-bg-elevated border border-border-muted rounded-lg px-6 py-10 text-center">
    {props.children}
  </div>
)
