import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Minimal design workbench. React is deduped so the linked formal
// ui-primitives package and local code share ONE React copy.
export default defineConfig({
  root: 'preview',
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
})
