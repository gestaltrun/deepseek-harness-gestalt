import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const MAIN = fileURLToPath(new URL('../src/main.tsx', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/product-entry-launch.fixture.tsx', import.meta.url))

function productLaunchFixture(): Plugin {
  return {
    name: 'dsh-mobile-product-launch-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      return source === './mobile-product-launch.ts' && importer === MAIN ? FIXTURE : null
    },
  }
}

export default defineConfig({
  plugins: [
    productLaunchFixture(),
    react(),
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))] }),
  ],
  build: { outDir: 'dist', emptyOutDir: true },
})
