import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { rendererAlias, rendererPlugins, rendererRoot } from './vite.shared.mts'

/**
 * GOXF design mockups (src/renderer/mock.html → src/renderer/src/mock).
 * Separate from the app and web builds: only scripts/goxf-mock.mjs uses it.
 */
export default defineConfig({
  root: rendererRoot,
  base: './',
  resolve: { alias: rendererAlias },
  plugins: rendererPlugins(),
  build: {
    outDir: resolve('dist/mock'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(rendererRoot, 'mock.html') }
  }
})
