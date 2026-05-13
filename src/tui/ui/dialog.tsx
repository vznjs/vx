// Modal dialog primitive — ported from opencode's `ui/dialog.tsx`.
// The whole point is overlay correctness: a full-viewport absolute
// box with a translucent black backdrop + zIndex, then the actual
// popup centered inside via flex. Without this layering pattern,
// cells outside the popup don't get repainted and you see old text
// bleed through (which is what broke our prior React-binding TUI).

import { useTerminalDimensions } from '@opentui/solid'
import { batch, createContext, Show, useContext, type JSX, type ParentProps } from 'solid-js'
import { createStore } from 'solid-js/store'
import { useTheme } from '../context/theme.tsx'

type DialogSize = 'medium' | 'large'

function widthFor(size: DialogSize): number {
  if (size === 'large') return 88
  return 60
}

function Dialog(
  props: ParentProps<{
    size?: DialogSize
    onClose: () => void
  }>,
): JSX.Element {
  const dimensions = useTerminalDimensions()
  const { theme, dialogBackdrop } = useTheme()

  return (
    <box
      onMouseUp={() => props.onClose?.()}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={Math.floor(dimensions().height / 4)}
      left={0}
      top={0}
      backgroundColor={dialogBackdrop}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => e.stopPropagation()}
        width={widthFor(props.size ?? 'medium')}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {props.children}
      </box>
    </box>
  )
}

interface StackEntry {
  element: JSX.Element
  onClose: (() => void) | undefined
}

function init(): {
  clear: () => void
  show: (element: JSX.Element, onClose?: () => void) => void
  readonly stack: StackEntry[]
  readonly size: DialogSize
  setSize: (size: DialogSize) => void
} {
  const [store, setStore] = createStore({
    stack: [] as StackEntry[],
    size: 'medium' as DialogSize,
  })

  return {
    clear() {
      for (const item of store.stack) item.onClose?.()
      batch(() => {
        setStore('size', 'medium')
        setStore('stack', [])
      })
    },
    show(element: JSX.Element, onClose?: () => void) {
      setStore('size', 'medium')
      setStore('stack', [...store.stack, { element, onClose }])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: DialogSize) {
      setStore('size', size)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps): JSX.Element {
  const value = init()
  return (
    <ctx.Provider value={value}>
      {props.children}
      <Show when={value.stack.length > 0}>
        <Dialog onClose={() => value.clear()} size={value.size}>
          {value.stack.at(-1)!.element}
        </Dialog>
      </Show>
    </ctx.Provider>
  )
}

export function useDialog(): DialogContext {
  const value = useContext(ctx)
  if (!value) throw new Error('useDialog must be used within a DialogProvider')
  return value
}
