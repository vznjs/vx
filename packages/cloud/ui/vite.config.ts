import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'
import unocss from 'unocss/vite'

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
      html.source = src
    },
  }
}

// The platform the dev server proxies API calls to. The SPA's default origin
// in dev is the page's own origin (the vite server), so proxying keeps every
// request SAME-ORIGIN — the HttpOnly session cookie and the CSRF header ride
// exactly like production, where the platform hosts the SPA itself. Without
// this, a UI contributor's fetches went cross-origin to :4321 and credentialed
// CORS (wildcard Allow-Origin, no Allow-Credentials) blocked the login flow.
const DEV_API = process.env['VX_CLOUD_DEV_PROXY'] ?? 'http://localhost:4321'
const proxied = ['/v1', '/health', '/mcp', '/events', '/stream']

export default defineConfig({
  plugins: [unocss(), solid(), singleFile()],
  server: {
    port: 5290,
    strictPort: false,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: DEV_API, changeOrigin: true, ws: true }]),
    ),
  },
  preview: {
    port: 5290,
  },
})
