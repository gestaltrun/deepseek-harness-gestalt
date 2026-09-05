#!/usr/bin/env node
/** Bundle the source-only hidden-window smoke for Electron's ESM main process. */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'scripts', 'hidden-window-smoke.ts')],
  outfile: join(root, 'out', 'hidden-window-smoke.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
})
