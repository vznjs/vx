// Single dark theme; opencode supports a full theme picker but we
// don't need that. The shape mirrors opencode so swapping in their
// theme JSON later is one file.

import { RGBA } from '@opentui/core'
import { createSimpleContext } from './helper.tsx'

export interface Theme {
  background: string
  backgroundPanel: string
  backgroundElement: string
  text: string
  textMuted: string
  textInverse: string
  border: string
  borderActive: string
  accent: string
  success: string
  warning: string
  error: string
  info: string
  cacheHit: string
}

const DARK: Theme = {
  background: '#0f172a',
  backgroundPanel: '#111827',
  backgroundElement: '#1f2937',
  text: '#f3f4f6',
  textMuted: '#9ca3af',
  textInverse: '#0f172a',
  border: '#374151',
  borderActive: '#a78bfa',
  accent: '#a78bfa',
  success: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
  info: '#06b6d4',
  cacheHit: '#c084fc',
}

const { provider: ThemeProvider, use: useTheme } = createSimpleContext({
  name: 'Theme',
  init: () => ({
    theme: DARK,
    mode: 'dark' as const,
    /** Translucent black for dialog backdrops. opencode pattern. */
    dialogBackdrop: RGBA.fromInts(0, 0, 0, 150),
  }),
})

export { ThemeProvider, useTheme }
