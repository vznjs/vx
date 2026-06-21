import { defineConfig, presetIcons, presetUno, transformerVariantGroup } from 'unocss'

export default defineConfig({
  presets: [presetUno(), presetIcons({ scale: 1.2 })],
  transformers: [transformerVariantGroup()],
  theme: {
    colors: {
      bg: 'var(--bg)',
      'bg-elevated': 'var(--bg-elevated)',
      fg: 'var(--fg)',
      'fg-muted': 'var(--fg-muted)',
      'border-muted': 'var(--border-muted)',
      accent: 'var(--accent)',
      success: 'var(--success)',
      failure: 'var(--failure)',
      skipped: 'var(--skipped)',
      cache: 'var(--cache)',
    },
    fontFamily: {
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  },
  preflights: [
    {
      getCSS: () => `
        :root {
          --bg: #0b0d10;
          --bg-elevated: #14181d;
          --fg: #e6e8ec;
          --fg-muted: #8a92a0;
          --border-muted: #232830;
          --accent: #c084fc;
          --success: #4ade80;
          --failure: #f87171;
          --skipped: #facc15;
          --cache: #38bdf8;
        }
        html, body, #root { height: 100%; }
        body {
          margin: 0;
          background: var(--bg);
          color: var(--fg);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          font-size: 14px;
        }
      `,
    },
  ],
})
