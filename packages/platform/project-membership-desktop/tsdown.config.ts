import { defineConfig } from 'tsdown'

/** Build the Desktop Web Host provider and invariant as independent Node entries. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
