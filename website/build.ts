/** Documentation build-output lifecycle shared by the standard and MPA entrypoints. */

import { lstatSync, rmSync, unlinkSync } from 'node:fs'

interface DocumentationBuildOptions {
  mpa?: string
  onAfterConfigResolve: (siteConfig: { outDir: string }) => void
}

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

/**
 * VitePress options that reset the resolved output before the current build writes it.
 *
 * @param mpa Whether to enable VitePress's MPA build mode.
 * @returns Build options sharing one output-ownership lifecycle across modes.
 */
export function documentationBuildOptions(mpa: boolean): DocumentationBuildOptions {
  return {
    ...(mpa ? { mpa: 'true' } : {}),
    onAfterConfigResolve(siteConfig) {
      resetDocumentationBuildOutput(siteConfig.outDir)
    },
  }
}
