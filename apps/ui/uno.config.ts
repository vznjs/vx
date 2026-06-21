import { defineConfig, presetIcons, presetUno, transformerVariantGroup } from 'unocss'

export default defineConfig({
  presets: [presetUno(), presetIcons({ scale: 1.0 })],
  transformers: [transformerVariantGroup()],
  theme: {
    colors: {
      // Surfaces
      bg: 'var(--bg)',
      surface: 'var(--surface)',
      'surface-2': 'var(--surface-2)',
      'surface-hover': 'var(--surface-hover)',
      // Text
      fg: 'var(--fg)',
      'fg-1': 'var(--fg-1)',
      'fg-2': 'var(--fg-2)',
      'fg-3': 'var(--fg-3)',
      // Borders
      border: 'var(--border)',
      'border-strong': 'var(--border-strong)',
      // Brand + semantic
      accent: 'var(--accent)',
      'accent-2': 'var(--accent-2)',
      success: 'var(--success)',
      warn: 'var(--warn)',
      danger: 'var(--danger)',
      info: 'var(--info)',
      // Cache provenance
      'cache-local': 'var(--cache-local)',
      'cache-remote': 'var(--cache-remote)',
      // Chart palette (8-step categorical, colorblind-friendlier)
      'chart-1': 'var(--chart-1)',
      'chart-2': 'var(--chart-2)',
      'chart-3': 'var(--chart-3)',
      'chart-4': 'var(--chart-4)',
      'chart-5': 'var(--chart-5)',
      'chart-6': 'var(--chart-6)',
      'chart-7': 'var(--chart-7)',
      'chart-8': 'var(--chart-8)',
    },
    fontFamily: {
      mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  },
  preflights: [
    {
      getCSS: () => `
        :root {
          color-scheme: dark;

          /* Surfaces — graded for layered depth */
          --bg: #07080a;
          --surface: #0e1014;
          --surface-2: #14171c;
          --surface-hover: #1a1e24;

          /* Text */
          --fg: #e7e9ee;
          --fg-1: #c2c7d0;
          --fg-2: #8a92a0;
          --fg-3: #5a6270;

          /* Borders */
          --border: #1d2128;
          --border-strong: #2a2f37;

          /* Brand */
          --accent: #a78bfa;
          --accent-2: #c084fc;

          /* Semantic */
          --success: #4ade80;
          --warn: #facc15;
          --danger: #f87171;
          --info: #38bdf8;

          /* Cache provenance */
          --cache-local: #38bdf8;
          --cache-remote: #818cf8;

          /* Chart palette */
          --chart-1: #a78bfa;
          --chart-2: #38bdf8;
          --chart-3: #4ade80;
          --chart-4: #facc15;
          --chart-5: #f472b6;
          --chart-6: #fb923c;
          --chart-7: #818cf8;
          --chart-8: #2dd4bf;
        }

        html, body, #root { height: 100%; }
        body {
          margin: 0;
          background: var(--bg);
          color: var(--fg);
          font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          font-feature-settings: "cv11", "ss01", "ss03";
          -webkit-font-smoothing: antialiased;
        }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-thumb {
          background: var(--border);
          border-radius: 6px;
          border: 2px solid var(--bg);
        }
        ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
        button, input, select { font: inherit; color: inherit; }
        button { background: none; border: none; cursor: pointer; }
        input, select { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
        input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(167, 139, 250, 0.15); }
        kbd {
          display: inline-flex; align-items: center;
          padding: 2px 6px; border-radius: 4px;
          background: var(--surface-2); border: 1px solid var(--border);
          font-family: var(--mono); font-size: 11px; color: var(--fg-2);
        }
        code { font-family: var(--mono); }
      `,
    },
  ],
})
