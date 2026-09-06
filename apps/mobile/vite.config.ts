import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { mobileRuntimeIdentity } from './vite-runtime-identity.ts'

export default defineConfig({
  plugins: [
    mobileRuntimeIdentity(),
    react(),
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))] }),
  ],
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome83' },
})
