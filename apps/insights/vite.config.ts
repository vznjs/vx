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
})
