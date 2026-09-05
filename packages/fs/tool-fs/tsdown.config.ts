import { defineConfig } from 'tsdown'

/** Build the package root and public read-policy helper. */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/read-policy.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
