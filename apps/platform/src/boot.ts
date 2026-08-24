/** Production Platform executable over the entry-owned launch composition. */

import { launchOperatedPlatform } from './launch.ts'

let running: Awaited<ReturnType<typeof launchOperatedPlatform>> | undefined
let requestedSignal: NodeJS.Signals | undefined
let shutdown: Promise<void> | undefined

const requestShutdown = async (signal: NodeJS.Signals): Promise<void> => {
  requestedSignal ??= signal
  process.exitCode ??= 0
  if (running === undefined) return
  shutdown ??= running.close()
    .catch((error: unknown) => {
      process.exitCode = 1
      console.error(`platform: shutdown after ${requestedSignal ?? signal} failed:`, error)
    })
    .finally(removeSignalHandlers)
  await shutdown
}
const onSigint = (): void => { void requestShutdown('SIGINT') }
const onSigterm = (): void => { void requestShutdown('SIGTERM') }
function removeSignalHandlers(): void {
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
}

process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
try {
  running = await launchOperatedPlatform()
  if (requestedSignal !== undefined) {
    await requestShutdown(requestedSignal)
  } else {
    console.error(`platform: listening on ${running.context.webServer.host}:${String(running.context.webServer.port)}`)
  }
} catch (error) {
  removeSignalHandlers()
  process.exitCode = 1
  throw error
}
