import { defineConfig, presetIcons, presetUno, transformerVariantGroup } from 'unocss'

// Theme colors are stored as SPACE-SEPARATED RGB CHANNELS (e.g. --accent:
// 167 139 250) and exposed to UnoCSS as `rgb(var(--x) / <alpha-value>)`, so
// opacity modifiers (`bg-accent/10`, `border-danger/25`) actually apply. With
// hex vars UnoCSS silently drops the alpha and every tint renders full-strength.
const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`

export default defineConfig({
  presets: [presetUno(), presetIcons({ scale: 1.0 })],
  transformers: [transformerVariantGroup()],
  // UnoCSS's default pipeline scans .tsx (and .html etc.) but NOT plain .ts or
  // .json. Everything that carries literal class strings outside .tsx must be
  // listed here: the pure-JSON views (chart stroke-/fill- tokens) and
  // src/jr/hints.ts (the tone-token → class map).
  content: { filesystem: ['src/views/**/*.json', 'src/jr/hints.ts'] },
  // Chart palette classes are computed from project names at runtime via
  // `paletteFor()` — UnoCSS's static analyzer can't see them, so we list
  // them explicitly.
  safelist: [
    ...['1', '2', '3', '4', '5', '6', '7', '8'].flatMap((n) => [
      `bg-chart-${n}`,
      `stroke-chart-${n}`,
      `fill-chart-${n}`,
    ]),
    // Identity classes are applied from literal maps in .ts files UnoCSS
    // doesn't scan (format.ts) — safelist keeps them generated.
    ...['0', '1', '2', '3', '4', '5'].flatMap((n) => [`text-ident-${n}`, `bg-ident-${n}`]),
    'text-ident-task',
    'bg-ident-task',
    // Semantic dot/bar colors referenced by catalog components via tone tokens.
    ...['success', 'warn', 'danger', 'accent', 'accent-2', 'cache-local', 'info'].flatMap((c) => [
      `bg-${c}`,
      `text-${c}`,
    ]),
    // RunGraph status styles — applied via a state→class map + computed classList
    // keys, so guarantee they're generated regardless of static extraction.
    ...['border', 'border-strong', 'accent', 'success', 'cache-local', 'danger', 'warn', 'fg-3'].flatMap(
      (c) => [`bg-${c}`, `text-${c}`, `border-${c}`, `border-${c}/40`, `border-${c}/50`, `border-${c}/70`],
    ),
    'stroke-warn',
    'stroke-border-strong',
    'ring-accent/40',
    'ring-warn/40',
  ],
  theme: {
    colors: {
      // Surfaces
      bg: rgb('--bg'),
      surface: rgb('--surface'),
      'surface-2': rgb('--surface-2'),
      'surface-hover': rgb('--surface-hover'),
      // Text
      fg: rgb('--fg'),
      'fg-1': rgb('--fg-1'),
      'fg-2': rgb('--fg-2'),
      'fg-3': rgb('--fg-3'),
      // Borders
      border: rgb('--border'),
      'border-strong': rgb('--border-strong'),
      // Brand + semantic
      accent: rgb('--accent'),
      'accent-2': rgb('--accent-2'),
      success: rgb('--success'),
      warn: rgb('--warn'),
      danger: rgb('--danger'),
      info: rgb('--info'),
      // Cache provenance
      'cache-local': rgb('--cache-local'),
      'cache-remote': rgb('--cache-remote'),
      // Chart palette (8-step categorical, colorblind-friendlier)
      'chart-1': rgb('--chart-1'),
      'chart-2': rgb('--chart-2'),
      'chart-3': rgb('--chart-3'),
      'chart-4': rgb('--chart-4'),
      'chart-5': rgb('--chart-5'),
      'chart-6': rgb('--chart-6'),
      'chart-7': rgb('--chart-7'),
      'chart-8': rgb('--chart-8'),
      'ident-0': rgb('--ident-0'),
      'ident-1': rgb('--ident-1'),
      'ident-2': rgb('--ident-2'),
      'ident-3': rgb('--ident-3'),
      'ident-4': rgb('--ident-4'),
      'ident-5': rgb('--ident-5'),
      'ident-task': rgb('--ident-task'),
    },
    fontFamily: {
      mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    boxShadow: {
      card: '0 1px 2px 0 rgb(0 0 0 / 0.4)',
      elevated: '0 8px 32px -12px rgb(0 0 0 / 0.7), 0 2px 8px -4px rgb(0 0 0 / 0.5)',
      glow: '0 0 0 1px rgb(167 139 250 / 0.25), 0 12px 32px -12px rgb(167 139 250 / 0.35)',
    },
  },
  preflights: [
    {
      getCSS: () => `
        :root {
          color-scheme: dark;
          --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

          /* Tokens are RGB CHANNELS (see top of file) — graded for depth. */
          --bg: 8 9 14;
          --surface: 15 17 23;
          --surface-2: 22 25 34;
          --surface-hover: 28 32 41;

          --fg: 236 238 243;
          --fg-1: 197 202 212;
          --fg-2: 139 147 163;
          --fg-3: 91 99 113;

          --border: 30 34 43;
          --border-strong: 44 49 60;

          --accent: 167 139 250;
          --accent-2: 192 132 252;

          --success: 74 222 128;
          --warn: 250 204 21;
          --danger: 248 113 113;
          --info: 56 189 248;

          --cache-local: 56 189 248;
          --cache-remote: 129 140 248;

          --chart-1: 167 139 250;
          --chart-2: 56 189 248;
          --chart-3: 74 222 128;
          --chart-4: 250 204 21;
          --chart-5: 244 114 182;
          --chart-6: 251 146 60;
          --chart-7: 129 140 248;
          --chart-8: 45 212 191;

          /* Identity hues (the astryx ident set): cool violet->teal for
             PROJECT names (stable hash), fixed pink for TASK names —
             deliberately outside the status palette so an id can never
             read as an outcome. */
          --ident-0: 167 139 250;
          --ident-1: 129 140 248;
          --ident-2: 96 165 250;
          --ident-3: 56 189 248;
          --ident-4: 34 211 238;
          --ident-5: 45 212 191;
          --ident-task: 244 114 182;
        }

        html, body, #root { height: 100%; }
        body {
          margin: 0;
          background: rgb(var(--bg));
          /* Subtle violet aurora behind everything for depth. */
          background-image:
            radial-gradient(1100px 520px at 18% -8%, rgb(var(--accent) / 0.10), transparent 60%),
            radial-gradient(900px 480px at 100% 0%, rgb(var(--info) / 0.05), transparent 55%);
          background-attachment: fixed;
          color: rgb(var(--fg));
          font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          font-feature-settings: "cv11", "ss01", "ss03";
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
        }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-thumb {
          background: rgb(var(--border-strong));
          border-radius: 8px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        ::-webkit-scrollbar-thumb:hover { background: rgb(58 65 80); background-clip: padding-box; }
        ::-webkit-scrollbar-corner { background: transparent; }
        * { scrollbar-width: thin; scrollbar-color: rgb(var(--border-strong)) transparent; }

        button, input, select { font: inherit; color: inherit; }
        button { background: none; border: none; cursor: pointer; }
        ::selection { background: rgb(var(--accent) / 0.3); }
        input, select {
          background: rgb(var(--surface-2));
          border: 1px solid rgb(var(--border));
          border-radius: 8px;
          padding: 7px 11px;
          transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
        }
        input::placeholder { color: rgb(var(--fg-3)); }
        input:focus, select:focus {
          outline: none;
          border-color: rgb(var(--accent));
          box-shadow: 0 0 0 3px rgb(var(--accent) / 0.18);
        }
        kbd {
          display: inline-flex; align-items: center;
          padding: 1px 6px; border-radius: 5px;
          background: rgb(var(--surface-2)); border: 1px solid rgb(var(--border));
          border-bottom-width: 2px;
          font-family: var(--mono); font-size: 10px; color: rgb(var(--fg-2));
        }
        code { font-family: var(--mono); }
        a { text-decoration: none; }
      `,
    },
  ],
})
