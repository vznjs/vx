import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Inline every JS chunk and CSS asset into index.html so the build emits a
 * single self-contained file. `vx serve --ui` embeds that one file into the
 * binary via `with { type: 'file' }`, so the dashboard ships inside `vx`
 * with no on-disk asset directory to resolve.
 */
function singleFile(): Plugin {
  return {
    name: 'vx-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['index.html']
      if (!html || html.type !== 'asset') return
      let src = String(html.source)
      // CRITICAL: pass the replacement as a FUNCTION so `$&`, `` $` ``, `$1`
      // etc. in the bundled JS/CSS aren't interpreted as String.replace
      // substitution patterns. A literal `$&` in a regex body would otherwise
      // splice the matched HTML tag into the middle of the script.
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && chunk.fileName.endsWith('.js')) {
          const tag = new RegExp(`<script[^>]*src="[^"]*${chunk.fileName}"[^>]*></script>`)
          src = src.replace(tag, () => `<script type="module">${chunk.code}</script>`)
          delete bundle[name]
        } else if (chunk.type === 'asset' && chunk.fileName.endsWith('.css')) {
          const link = new RegExp(`<link[^>]*href="[^"]*${chunk.fileName}"[^>]*>`)
          src = src.replace(link, () => `<style>${String(chunk.source)}</style>`)
          delete bundle[name]
        }
      }
      // Vite replaces __VITE_PRELOAD__ markers in JS chunks in a LATER
      // generateBundle stage — after this plugin moved the code into the HTML
      // asset, where that replacer never looks. With one inlined chunk there
      // are no dep lists to preload, so the correct substitution is `void 0`
      // (what Vite itself emits under inlineDynamicImports).
      src = src.replace(/__VITE_PRELOAD__/g, 'void 0')
      html.source = src
    },
  }
}

export default defineConfig({
  plugins: [react(), singleFile()],
  build: {
    rollupOptions: {
      // One chunk, no code-splitting: a dynamic import would otherwise emit
      // Vite's __VITE_PRELOAD__ helper referencing chunk files this build
      // inlines and deletes — throwing at runtime in the embedded SPA.
      output: { inlineDynamicImports: true },
    },
  },
  server: {
    port: 5290,
    strictPort: false,
  },
  preview: {
    port: 5290,
  },
})
