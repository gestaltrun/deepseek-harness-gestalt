import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Keyless, serial built-Web lifecycle acceptance on a clean committed head. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['apps/web/tests/web-acceptance.acceptance.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
  },
})
