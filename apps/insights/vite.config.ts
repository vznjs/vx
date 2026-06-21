import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import unocss from 'unocss/vite'

export default defineConfig({
  plugins: [unocss(), solid()],
  server: {
    port: 5290,
    strictPort: false,
  },
  preview: {
    port: 5290,
  },
  optimizeDeps: {
    // DuckDB-WASM ships its own ESM workers + WASM blobs; let Vite bundle them
    // as-is rather than pre-bundle and break the worker URL resolution.
    exclude: ['@duckdb/duckdb-wasm'],
  },
})
