import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import type { SystemBrowser } from '@deepseek-ai/dsh-platform-account-client'

/**
 * Native Capacitor Browser when the process is a packaged WebView.
 * A Vite or simulator browsing context navigates the current document so
 * `load()` can resume polling after the authorization URL returns.
 */
export const mobileSystemBrowser: SystemBrowser = {
  open(url) {
    if (!Capacitor.isNativePlatform()) {
      window.location.assign(url)
      return Promise.resolve()
    }
    return Browser.open({ url })
  },
}
