/** Compatibility shims for the supported Android System WebView floor. */
import 'core-js/actual/aggregate-error.js'
import 'core-js/actual/array/at.js'
import 'core-js/actual/object/has-own.js'
import 'core-js/actual/string/replace-all.js'
import { randomUuid } from './random-uuid.ts'

type LegacyCrypto = Omit<Crypto, 'randomUUID'> & {
  randomUUID?: () => `${string}-${string}-${string}-${string}-${string}`
}

/** Install standards-compatible APIs absent from Android System WebView 83. */
export function installMobileWebViewCompatibility(): void {
  if (typeof Element.prototype.replaceChildren !== 'function') {
    Object.defineProperty(Element.prototype, 'replaceChildren', {
      configurable: true,
      value(this: Element, ...nodes: Array<Node | string>): void {
        this.textContent = ''
        this.append(...nodes)
      },
      writable: true,
    })
  }

  const systemCrypto = globalThis.crypto as LegacyCrypto | undefined
  if (systemCrypto !== undefined
    && typeof systemCrypto.randomUUID !== 'function'
    && typeof systemCrypto.getRandomValues === 'function') {
    Object.defineProperty(systemCrypto, 'randomUUID', {
      configurable: true,
      value: randomUuid,
      writable: true,
    })
  }
}

installMobileWebViewCompatibility()
