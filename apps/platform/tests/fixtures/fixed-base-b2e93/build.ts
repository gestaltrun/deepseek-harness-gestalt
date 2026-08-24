/** Build and load the exact fixed-base Remote Attachments HTTP consumer. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Fixed delivery-base commit represented by the source snapshot. */
export const FIXED_BASE_ATTACHMENT_CONSUMER_SHA = 'b2e93d3c835043ffb204942bbfe122d67eb2ebae'
/** SHA-256 of `packages/platform/remote-attachments/src/http.ts` at the fixed base. */
export const FIXED_BASE_ATTACHMENT_HTTP_SOURCE_SHA256 = '04e4dbba1742e94c43b78bc4cdbc2650239d96691dd74b829b578c99a551129f'

/** Built historical HTTP entry and its temporary artifact owner. */
export interface BuiltFixedBaseAttachmentHttp {
  apply(context: Context, config: { origin: string }): void
  dispose(): Promise<void>
}

/**
 * Bundle the historical source with the repository toolchain and load its product route.
 * @returns built HTTP plugin plus removal for its temporary artifact.
 */
export async function buildFixedBaseAttachmentHttp(): Promise<BuiltFixedBaseAttachmentHttp> {
  const root = resolve(import.meta.dirname, '../../../../..')
  const output = await mkdtemp(join(tmpdir(), 'dsh-fixed-base-attachment-http-'))
  const sourceRoot = join(output, 'source')
  const source = join(sourceRoot, 'http.ts')
  const snapshot = await readFile(join(import.meta.dirname, 'http.ts.fixture'))
  if (createHash('sha256').update(snapshot).digest('hex') !== FIXED_BASE_ATTACHMENT_HTTP_SOURCE_SHA256) {
    await rm(output, { recursive: true, force: true })
    throw new TypeError('fixed-base attachment HTTP source digest is invalid')
  }
  await mkdir(sourceRoot)
  await writeFile(source, snapshot)
  await writeFile(join(sourceRoot, 'index.ts'), [
    "export { RemoteAttachmentError, type RemoteAttachmentErrorCode } from '@deepseek-ai/dsh-remote-attachments'",
    '',
  ].join('\n'))
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const built = spawnSync(pnpm, [
    'exec', 'tsdown', source,
    '--no-config', '--format', 'esm', '--platform', 'node', '--target', 'es2024',
    '--out-dir', join(output, 'dist'), '--logLevel', 'error',
  ], { cwd: root, encoding: 'utf8' })
  if (built.status !== 0) {
    await rm(output, { recursive: true, force: true })
    throw new Error(`fixed-base attachment HTTP build failed: ${built.stderr}`)
  }
  const loaded: unknown = await import(pathToFileURL(join(output, 'dist', 'http.mjs')).href)
  if (typeof loaded !== 'object' || loaded === null || !('apply' in loaded) || typeof loaded.apply !== 'function') {
    await rm(output, { recursive: true, force: true })
    throw new TypeError('fixed-base attachment HTTP artifact does not export apply')
  }
  return {
    apply: loaded.apply as BuiltFixedBaseAttachmentHttp['apply'],
    dispose: async () => { await rm(output, { recursive: true, force: true }) },
  }
}
