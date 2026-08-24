/** Product wiring from authenticated projection DTOs to the encrypted Companion Cache. */

import type { PlatformAccountId, PlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  CompanionCache,
  CompanionUncertainOperationSettlement,
  IndexedDbCompanionCacheStore,
  WebCryptoCompanionCacheCipher,
  companionCacheDatabaseName,
  parseCompanionDesktopId,
  type CompanionCacheKeySource,
} from './companion-cache.ts'
import type { PairingCompanionKeyVault } from './companion-keys.ts'
import {
  assertCompanionJsonProjection,
  type MobileCompanionProjectionDto,
} from './companion-projection.ts'
import type { MobileCompanionProjectionCache } from './companion-surface.ts'

/** Encrypted cache owner for one Account and one selected Personal Pairing. */
export class MobileCompanionProjectionCacheRuntime implements MobileCompanionProjectionCache {
  readonly #desktopId
  readonly #cache
  readonly operationSettlement: CompanionUncertainOperationSettlement
  #operations: Promise<void> = Promise.resolve()

  constructor(options: {
    environment: PlatformEnvironment
    accountId: PlatformAccountId
    pairingId: PersonalPairingId
    keys: Pick<PairingCompanionKeyVault, 'attachmentKeyMaterial'>
  }) {
    this.#desktopId = parseCompanionDesktopId(options.pairingId)
    const source = new PairingCacheKeySource(options.pairingId, options.keys)
    const store = new IndexedDbCompanionCacheStore(companionCacheDatabaseName(options.environment, options.accountId))
    this.#cache = new CompanionCache(store, new WebCryptoCompanionCacheCipher(source))
    this.operationSettlement = new CompanionUncertainOperationSettlement(store, this.#desktopId)
  }

  async save(projection: MobileCompanionProjectionDto): Promise<void> {
    await this.enqueue(async () => {
      await this.#cache.saveOpenedContent(this.#desktopId, 'projection-snapshot', JSON.stringify({
        version: 1,
        projection,
      }))
    })
  }

  async restore(): Promise<MobileCompanionProjectionDto | undefined> {
    return await this.enqueue(async () => {
      const snapshot = await this.#cache.loadOpenedContent(this.#desktopId, 'projection-snapshot')
      if (snapshot === undefined) return undefined
      let candidate: unknown
      try { candidate = unknownJson(snapshot) } catch {
        throw new TypeError('Companion Cache projection must contain JSON')
      }
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
        || (candidate as Record<string, unknown>).version !== 1) {
        throw new TypeError('Companion Cache projection snapshot version is unsupported')
      }
      const projection = (candidate as Record<string, unknown>).projection
      assertCompanionJsonProjection(projection)
      return projection
    })
  }

  async clearContent(): Promise<void> {
    await this.enqueue(async () => { await this.#cache.clearDesktopContent(this.#desktopId) })
  }

  async destroy(): Promise<void> {
    await this.enqueue(async () => { await this.#cache.destroyDesktopCache(this.#desktopId) })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation)
    this.#operations = result.then(() => undefined, () => undefined)
    return result
  }
}

function unknownJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

class PairingCacheKeySource implements CompanionCacheKeySource {
  constructor(
    private readonly pairingId: PersonalPairingId,
    private readonly keys: Pick<PairingCompanionKeyVault, 'attachmentKeyMaterial'>,
  ) {}

  async keyFor(desktopId: ReturnType<typeof parseCompanionDesktopId>): Promise<CryptoKey> {
    if (String(desktopId) !== String(this.pairingId)) throw new Error('Companion Cache key belongs to another Personal Pairing')
    const material = this.keys.attachmentKeyMaterial(this.pairingId)
    if (material === undefined) throw new Error('Companion Cache has no retained Personal Pairing key')
    try {
      const keyBytes = Uint8Array.from(material)
      const baseKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveKey'])
      return await crypto.subtle.deriveKey({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('DeepSeek Gestalt Companion Cache v1'),
        info: new TextEncoder().encode(desktopId),
      }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    } finally {
      material.fill(0)
    }
  }
}
