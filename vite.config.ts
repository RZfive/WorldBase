import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue({
    template: {
      compilerOptions: {
        isCustomElement: (tag) => tag === 'webview'
      }
    }
  })],
  base: './',
  build: {
    target: 'chrome140',
    cssTarget: 'chrome140',
    modulePreload: false,
    minify: 'esbuild'
  }
})
