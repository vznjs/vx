import { defineConfig, presetUno, presetIcons, transformerVariantGroup } from 'unocss'

export default defineConfig({
  presets: [presetUno(), presetIcons({ scale: 1.1, warn: true })],
  transformers: [transformerVariantGroup()],
  theme: {
    colors: {
      bg: {
        DEFAULT: '#0b0d10',
        elevated: '#13161a',
        muted: '#1a1d22',
      },
      border: {
        DEFAULT: '#262a30',
        muted: '#1d2025',
      },
      fg: {
        DEFAULT: '#e7eaee',
        muted: '#9aa3ad',
        subtle: '#6b7480',
      },
      accent: {
        DEFAULT: '#7dd3fc',
        muted: '#0c4a6e',
      },
      ok: '#86efac',
      warn: '#fcd34d',
      err: '#fca5a5',
    },
    fontFamily: {
      sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    },
  },
})
