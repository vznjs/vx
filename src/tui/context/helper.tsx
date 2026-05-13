// Ported from opencode's TUI: a tiny helper to define a typed
// SolidJS context + provider in one shot. The opencode TUI uses
// this everywhere instead of hand-rolling `createContext`.

import { createContext, Show, useContext, type ParentProps } from 'solid-js'

export function createSimpleContext<T, Props extends Record<string, unknown>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}): {
  provider: (props: ParentProps<Props>) => ReturnType<typeof Show>
  use: () => T
} {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = (input.init as (p: Props) => T)(props)
      // opencode uses an `init.ready` escape hatch so async-bootstrapped
      // contexts can hold their children until ready. Most consumers
      // don't need it.
      const ready = (init as unknown as { ready?: boolean }).ready
      return (
        <Show when={ready === undefined || ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
