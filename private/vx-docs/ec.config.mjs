import { defineEcConfig } from '@astrojs/starlight/expressive-code'
import { ansiContrast } from './src/plugins/ansi-contrast.ts'

// Here, not in astro.config.mjs: the <Code> component (the feature pages)
// renders with this file's config, and a plugin cannot cross astro's
// serialized config.
// One theme: code reads as a dark screen in the light theme too, the way vx
// prints it (M 2026-11-23: the light theme is vx for daylight, not paper).
export default defineEcConfig({
  themes: ['starlight-dark'],
  // The dark theme's own surfaces, fixed: the page's tokens turn light.
  useStarlightUiThemeColors: false,
  styleOverrides: {
    borderColor: '#2c333b',
    codeBackground: '#14171b',
    frames: {
      editorBackground: '#14171b',
      terminalBackground: '#14171b',
      editorTabBarBackground: '#0a0b0d',
      editorActiveTabBackground: '#14171b',
      editorActiveTabIndicatorTopColor: '#c6f84e',
      editorActiveTabIndicatorBottomColor: 'transparent',
      editorTabBarBorderBottomColor: '#2c333b',
      terminalTitlebarBackground: '#0a0b0d',
      terminalTitlebarBorderBottomColor: '#2c333b',
      terminalTitlebarDotsForeground: '#5b635f',
      frameBoxShadowCssValue: 'none',
    },
    textMarkers: {
      markBackground: '#c6f84e1f',
      markBorderColor: '#c6f84e66',
    },
  },
  plugins: [ansiContrast()],
})
