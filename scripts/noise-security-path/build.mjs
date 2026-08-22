/** Build the reviewed Snow adapter and its browser-target WebAssembly module. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const proofRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(proofRoot, '../..')
const targetRoot = join(repositoryRoot, '.artifacts/noise-security-path')
const wasm = join(targetRoot, 'wasm32-unknown-unknown/release/dsh_noise_security_path_proof.wasm')
const pkg = join(proofRoot, 'pkg')

mkdirSync(targetRoot, { recursive: true })
execFileSync('cargo', [
  'build',
  '--locked',
  '--manifest-path',
  join(proofRoot, 'Cargo.toml'),
  '--target',
  'wasm32-unknown-unknown',
  '--release',
], {
  cwd: repositoryRoot,
  env: { ...process.env, CARGO_TARGET_DIR: targetRoot },
  stdio: 'inherit',
})
execFileSync('wasm-bindgen', [wasm, '--target', 'web', '--out-dir', pkg], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})

const declarationPath = join(pkg, 'dsh_noise_security_path_proof.d.ts')
const declaration = readFileSync(declarationPath, 'utf8')
  .replace('/* eslint-disable */\n', `/* eslint-disable */\n\nimport type {\n  InitInput as SharedInitInput,\n  SyncInitInput as SharedSyncInitInput,\n} from '../../../packages/platform/noise-channel/pkg/dsh_noise_channel.js'\n`)
  .replace(
    'export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;',
    'export type InitInput = SharedInitInput;',
  )
  .replace(
    'export type SyncInitInput = BufferSource | WebAssembly.Module;',
    'export type SyncInitInput = SharedSyncInitInput;',
  )
  .replace(/\n\/\*\*\n \* Instantiates[\s\S]*$/u, `
export const initSync: (module: { module: SyncInitInput } | SyncInitInput) => InitOutput
declare const init: (
  moduleOrPath?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>
) => Promise<InitOutput>
export default init
`)
writeFileSync(declarationPath, declaration)
