import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import unocss from 'unocss/vite'

export default defineConfig({
  plugins: [unocss(), solid()],
  server: {
    port: 5280,
    proxy: {
      '/api': 'http://127.0.0.1:4280',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
