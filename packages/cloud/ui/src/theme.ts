// The vx brand theme — "aurora": deep-space dark canvas washed with a
// violet/cyan aurora, glassy elevated surfaces, electric-violet accent, and
// Space Grotesk display type (embedded via fonts.css). Extends the neutral
// theme so anything unspecified keeps sane defaults; light mode carries the
// same identity on a violet-tinted paper canvas.
//
// Everything routes through astryx's theming seam (tokens + component
// overrides). The custom --vx-* primitives the overrides reference (aurora
// gradient, glass fills, brand gradient) live in brand.css keyed off the
// data-theme attribute astryx sets — the theme token map's TokenName union
// is closed and light-dark() is color-only, so they can't ride the tokens.

import { defineTheme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral'

const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export const vxTheme = defineTheme({
  name: 'vx',
  extends: neutralTheme,
  typography: {
    scale: { base: 14, ratio: 1.22 },
    heading: { family: 'Space Grotesk', fallbacks: SANS, weights: { 3: 'bold', 4: 'bold' } },
    code: {
      family: 'ui-monospace',
      fallbacks: '"SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  radius: { base: 5, multiplier: 1.4 },
  tokens: {
    // Canvas + surfaces — cool violet-tinted spine instead of pure gray.
    '--color-background-body': ['#f4f3fa', '#0d0d15'],
    '--color-background-surface': ['#ffffff', '#232336'],
    '--color-background-card': ['#ffffff', '#15151f'],
    '--color-background-popover': ['#ffffff', '#1d1d2c'],
    '--color-background-muted': ['#eceaf6', '#131320'],

    // Electric violet accent (the old identity's wordmark hue).
    '--color-accent': ['#7c3aed', '#a78bfa'],
    '--color-accent-muted': ['#7c3aed24', '#7c3aed3d'],
    '--color-on-accent': ['#ffffff', '#170b2e'],
    '--color-text-accent': ['#6d28d9', '#c4b5fd'],
    '--color-icon-accent': ['#7c3aed', '#a78bfa'],

    // Text — cool, slightly violet neutrals.
    '--color-text-primary': ['#17162a', '#ecebf5'],
    '--color-text-secondary': ['#5f5d7a', '#a2a1bd'],
    '--color-text-disabled': ['#a8a6c2', '#565470'],
    '--color-icon-primary': ['#17162a', '#ecebf5'],
    '--color-icon-secondary': ['#5f5d7a', '#a2a1bd'],
    '--color-icon-disabled': ['#a8a6c2', '#565470'],

    // Borders carry a whisper of violet so cards read intentional, not gray.
    '--color-border': ['#7c3aed1c', '#a78bfa24'],
    '--color-border-emphasized': ['#cfcbe8', '#4c4766'],
    '--color-skeleton': ['#e4e1f3', '#34324d'],
    '--color-neutral': ['#7c3aed14', '#a78bfa1f'],
    '--color-overlay-hover': ['#7c3aed0d', '#a78bfa14'],
    '--color-overlay-pressed': ['#7c3aed1a', '#a78bfa24'],

    // Status — vivid on the dark canvas, deep on paper.
    '--color-success': ['#0f7a2d', '#6ee7a0'],
    '--color-error': ['#d31734', '#fb7185'],
    '--color-warning': ['#8a6400', '#fbbf24'],
    '--color-success-muted': ['#bfe9c6', '#34d3993D'],
    '--color-error-muted': ['#fbd0cd', '#fb71853D'],
    '--color-warning-muted': ['#f6dda0', '#fbbf243D'],

    // Categorical data palette — aurora family (violet / cyan / pink / lime /
    // amber / blue). Charts + status fills read these.
    '--color-data-categorical-blue': ['#2563eb', '#60a5fa'],
    '--color-data-categorical-orange': ['#d97706', '#fbbf24'],
    '--color-data-categorical-green': ['#15803d', '#a3e635'],
    '--color-data-categorical-purple': ['#7c3aed', '#a78bfa'],
    '--color-data-neutral': ['#8886a5', '#6f6d8c'],
    '--color-icon-cyan': ['#0891b2', '#22d3ee'],
    '--color-icon-pink': ['#db2777', '#f472b6'],
    '--color-icon-blue': ['#2563eb', '#60a5fa'],
    '--color-icon-purple': ['#7c3aed', '#a78bfa'],

  },
  components: {
    // The whole shell sits on the aurora canvas.
    'app-shell': {
      base: { background: 'var(--vx-aurora)' },
    },
    // Nav chrome is transparent glass so the aurora shows through.
    'app-shell-sidenav': {
      base: {
        backgroundColor: 'var(--vx-glass-chrome)',
        backdropFilter: 'blur(18px) saturate(1.35)',
      },
    },
    'app-shell-header': {
      base: {
        backgroundColor: 'var(--vx-glass-chrome)',
        backdropFilter: 'blur(18px) saturate(1.35)',
      },
    },
    'side-nav': {
      base: { backgroundColor: 'transparent' },
    },
    'top-nav': {
      base: { backgroundColor: 'transparent' },
    },
    // Tables sit on their own glass slab so dense rows read anchored on
    // the aurora canvas instead of floating over it.
    'table-scroll-wrapper': {
      base: {
        backgroundColor: 'var(--vx-glass-card)',
        backdropFilter: 'blur(14px) saturate(1.25)',
        border: '1px solid var(--vx-glass-border)',
        borderRadius: 'var(--radius-container)',
        boxShadow:
          '0 10px 30px -12px var(--vx-shadow-drop), inset 0 1px 0 var(--vx-edge-highlight)',
      },
    },
    'table-header-cell': {
      base: {
        backgroundColor: 'transparent',
        color: 'var(--color-text-secondary)',
        textTransform: 'uppercase',
        fontSize: '11px',
        letterSpacing: '0.06em',
      },
    },
    // Cards are glass: translucent fill, hairline violet border, soft depth.
    card: {
      base: {
        backgroundColor: 'var(--vx-glass-card)',
        backdropFilter: 'blur(14px) saturate(1.25)',
        borderColor: 'var(--vx-glass-border)',
        boxShadow:
          '0 10px 30px -12px var(--vx-shadow-drop), inset 0 1px 0 var(--vx-edge-highlight)',
      },
    },
  },
})
