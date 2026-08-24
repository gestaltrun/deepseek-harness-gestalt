/** Execute the committed browser WebAssembly module in Node. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initSync, run_proof_json } from './pkg/dsh_noise_security_path_proof.js'
import {
  initShippedSync,
  runShippedImplementationProof,
} from './web/shipped-proof.js'

const proofRoot = dirname(fileURLToPath(import.meta.url))
const runtime = process.argv[2] ?? `Node ${process.versions.node}`
const wasm = readFileSync(join(proofRoot, 'pkg/dsh_noise_security_path_proof_bg.wasm'))

initSync({ module: wasm })
initShippedSync({ module: readFileSync(join(proofRoot, 'pkg/dsh_noise_channel_bg.wasm')) })
const report = JSON.parse(run_proof_json(runtime))
report.shippedImplementation = runShippedImplementationProof()
report.allPass = report.allPass === true
  && Object.values(report.shippedImplementation).every(value => value === true)
process.stdout.write(`${JSON.stringify(report)}\n`)
