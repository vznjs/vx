// Light/dark/system mode, persisted beside the connection settings. The old
// dashboard was dark-only; dark stays the default identity, but astryx themes
// both modes so the toggle is nearly free.

import { signal, useSignal } from './store.ts'

export type ThemeMode = 'light' | 'dark' | 'system'

const MODE_KEY = 'vx-ui:theme-mode'

export function getStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'dark'
  const stored = localStorage.getItem(MODE_KEY)
  return stored === 'light' || stored === 'system' ? stored : 'dark'
}

const mode = signal<ThemeMode>(getStoredMode())

export function useThemeMode(): [ThemeMode, (next: ThemeMode) => void] {
  return [
    useSignal(mode),
    (next) => {
      mode.set(next)
      if (typeof localStorage !== 'undefined') localStorage.setItem(MODE_KEY, next)
      document.documentElement.style.colorScheme = next === 'light' ? 'light' : 'dark'
    },
  ]
}
