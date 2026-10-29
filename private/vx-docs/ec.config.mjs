import { defineEcConfig } from '@astrojs/starlight/expressive-code'
import { ansiContrast } from './src/plugins/ansi-contrast.ts'

// Here, not in astro.config.mjs: the <Code> component (the feature pages)
// renders with this file's config, and a plugin cannot cross astro's
// serialized config.
export default defineEcConfig({
  plugins: [ansiContrast()],
})
