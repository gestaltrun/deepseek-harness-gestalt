import { Browser } from '@capacitor/browser'
import type { SystemBrowser } from '@deepseek-ai/dsh-platform-account-client'

/** Capacitor adapter that opens the native system-provided browser surface. */
export const mobileSystemBrowser: SystemBrowser = {
  open(url) {
    return Browser.open({ url })
  },
}
