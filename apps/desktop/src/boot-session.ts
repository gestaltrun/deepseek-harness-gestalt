/**
 * Desktop cold-start helpers that do not import Electron: overlapped Host
 * spawn, shell-ready polling, and the boot-mark background colors.
 * @module @deepseek-ai/dsh-desktop/boot-session
 */

/** Light-theme boot mark background; matches ui-theme `--dsw-alias-bg-base` fallback. */
export const BOOT_BACKGROUND_LIGHT = '#f9fafb'
/** Dark-theme boot mark background; matches ui-theme dark `--dsw-alias-bg-base`. */
export const BOOT_BACKGROUND_DARK = '#151517'

/** Expression the Desktop Host evaluates in the Session Surface after `loadURL`. */
export const SHELL_READY_EXPRESSION = 'globalThis.__DSH_SHELL_READY__ === true'
  + '|| document.querySelector("[data-desktop-chrome]") !== null'
  + '|| document.body?.innerText?.includes("Failed to load plugins") === true'

/**
 * Select the window background that matches the local boot mark.
 * @param dark - whether the operating-system scheme is dark.
 * @returns a CSS hex color.
 */
export function bootBackgroundColor(dark: boolean): string {
  return dark ? BOOT_BACKGROUND_DARK : BOOT_BACKGROUND_LIGHT
}

/**
 * Start the Web Host immediately and only join it after other startup work.
 * Account restore does not need the Host URL, so the two waits overlap.
 * @param startHost - one Web Host spawn attempt (or the retry wrapper).
 * @param work - Account start and other Host-independent startup.
 * @returns the Host once both the spawn and `work` have settled.
 */
export async function joinHostAfter<T>(
  startHost: () => Promise<T>,
  work: () => Promise<void>,
): Promise<T> {
  const host = startHost()
  await work()
  return await host
}

/** Clock used by {@link pollUntilTrue} so tests can drive time without sleeping. */
export interface PollClock {
  now(): number
  sleep(ms: number): Promise<void>
}

/**
 * Poll until `probe` is true or `timeoutMs` elapses.
 * @param probe - one readiness check; false or a thrown probe keeps polling.
 * @param timeoutMs - maximum wait.
 * @param clock - time source.
 * @returns whether the probe became true before the deadline.
 */
export async function pollUntilTrue(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  clock: PollClock,
): Promise<boolean> {
  const deadline = clock.now() + timeoutMs
  while (clock.now() < deadline) {
    let ready = false
    try {
      ready = await probe()
    } catch (error: unknown) {
      // Mid-navigation and destroyed frames reject executeJavaScript; keep polling.
      void error
    }
    if (ready) return true
    await clock.sleep(50)
  }
  return false
}

/**
 * Read the Session Surface ready flag, treating probe failure as not-ready.
 * @param execute - `webContents.executeJavaScript` or a test double.
 * @returns true only when the renderer published `__DSH_SHELL_READY__`.
 */
export async function probeShellReady(
  execute: (code: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    return await execute(SHELL_READY_EXPRESSION) === true
  } catch (error: unknown) {
    // Mid-navigation and destroyed frames reject executeJavaScript; keep polling.
    void error
    return false
  }
}
