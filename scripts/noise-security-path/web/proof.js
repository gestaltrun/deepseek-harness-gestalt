import init, { run_proof_json } from '../pkg/dsh_noise_security_path_proof.js'
import { initShipped, runShippedImplementationProof } from './shipped-proof.js'

const output = document.querySelector('#report')
const runtime = new URLSearchParams(location.search).get('runtime') ?? 'WebView'
const androidBridge = globalThis.NoiseProof

function publish(report) {
  output.textContent = report
  document.body.dataset.status = 'pass'
  globalThis.webkit?.messageHandlers?.noiseProof?.postMessage(report)
  if (androidBridge !== undefined) androidBridge.report(report)
}

function fail(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  output.textContent = message
  document.body.dataset.status = 'fail'
  globalThis.webkit?.messageHandlers?.noiseProof?.postMessage(`ERROR:${message}`)
  if (androidBridge !== undefined) androidBridge.report(`ERROR:${message}`)
}

try {
  if (androidBridge !== undefined) androidBridge.reportProgress('script loaded')
  await init()
  await initShipped()
  if (androidBridge !== undefined) androidBridge.reportProgress('WASM initialized')
  const report = JSON.parse(run_proof_json(runtime))
  report.shippedImplementation = runShippedImplementationProof()
  report.allPass = report.allPass === true
    && Object.values(report.shippedImplementation).every(value => value === true)
  if (androidBridge !== undefined) androidBridge.reportProgress('proof completed')
  publish(JSON.stringify(report))
} catch (error) {
  fail(error)
}
