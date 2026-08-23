import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/boot.ts', 'src/attachment-storage-cutover-cli.ts', 'src/oss-lifecycle-cli.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  deps: {
    neverBundle: ['pg', 'redis'],
    alwaysBundle: [/^@deepseek-ai\//],
  },
})
