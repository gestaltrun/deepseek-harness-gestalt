/** Production launch indirection used by built-entry tests to supply explicit composition inputs. */

/**
 * Start the operated Mobile product composition.
 * @param start - production composition owner resolved by the bundled entry.
 * @returns product startup completion.
 */
export function launchMobileProduct(start: () => Promise<void>): Promise<void> {
  return start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    renderMobileStartupFailure(message)
    console.error('[mobile-product] startup failed:', error)
    throw error
  })
}

function renderMobileStartupFailure(message: string): void {
  const root = document.getElementById('root')
  if (root === null) return
  const section = document.createElement('section')
  section.dataset.mobileStartup = 'failed'
  section.setAttribute('role', 'alert')
  const heading = document.createElement('h1')
  heading.textContent = 'Mobile 启动失败 / Startup failed'
  const detail = document.createElement('p')
  detail.textContent = message
  const recovery = document.createElement('small')
  recovery.textContent = '请重新启动应用；若问题持续，请保留此消息。 / Restart the app; keep this message if the problem continues.'
  section.append(heading, detail, recovery)
  root.textContent = ''
  root.append(section)
}
