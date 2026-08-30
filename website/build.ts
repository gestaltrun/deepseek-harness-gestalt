/** Build the documentation site from a clean, resolved output directory. */

import { lstatSync, rmSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vitepress'

/**
 * Remove the exact disposable output directory resolved for one documentation build.
 *
 * Link-shaped paths are unlinked instead of recursively removed so cleanup cannot
 * traverse a symlink or Windows junction into a target the build does not own.
 *
 * @param outDir Resolved VitePress output directory owned by the upcoming build.
 */
export function resetDocumentationBuildOutput(outDir: string): void {
  const entry = lstatSync(outDir, { throwIfNoEntry: false })
  if (entry === undefined) return
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    unlinkSync(outDir)
    return
  }
  rmSync(outDir, { recursive: true, force: true })
}

async function buildDocumentationSite(mpa: boolean): Promise<void> {
  await build(import.meta.dirname, {
    ...(mpa ? { mpa: 'true' } : {}),
    onAfterConfigResolve(siteConfig) {
      resetDocumentationBuildOutput(siteConfig.outDir)
    },
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--mpa') || args.filter(arg => arg === '--mpa').length > 1) {
    throw new Error('Usage: tsx website/build.ts [--mpa]')
  }
  await buildDocumentationSite(args[0] === '--mpa')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
