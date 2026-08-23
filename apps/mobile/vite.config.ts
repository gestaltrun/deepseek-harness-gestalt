import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const developmentOrigin = process.env.VITE_PLATFORM_DEVELOPMENT_ORIGIN ?? 'https://127.0.0.1:8443'

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))] }),
  ],
  server: {
    proxy: {
      '/v1': {
        target: developmentOrigin,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
