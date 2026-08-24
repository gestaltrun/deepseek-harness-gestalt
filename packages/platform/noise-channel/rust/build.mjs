/** Build the pinned Snow adapter and browser-target WebAssembly module. */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rustRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(rustRoot, '..')
const repositoryRoot = resolve(packageRoot, '../../..')
const targetRoot = join(repositoryRoot, '.artifacts/noise-channel')
const wasm = join(targetRoot, 'wasm32-unknown-unknown/release/dsh_noise_channel.wasm')
const pkg = join(packageRoot, 'pkg')

mkdirSync(targetRoot, { recursive: true })
execFileSync('cargo', [
  'build',
  '--locked',
  '--manifest-path',
  join(rustRoot, 'Cargo.toml'),
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
