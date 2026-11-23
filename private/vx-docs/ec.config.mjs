import { defineEcConfig } from '@astrojs/starlight/expressive-code'
import { ansiContrast } from './src/plugins/ansi-contrast.ts'
import { codeRegionNames } from './src/plugins/code-region-names.ts'

// Here, not in astro.config.mjs: the <Code> component renders with this
// file's config, and a plugin cannot cross astro's serialized config.
export default defineEcConfig({
  plugins: [ansiContrast(), codeRegionNames()],
})
