/** Electron-only PhoneEnvironment subclass whose asset bytes come from the runner's loopback fixture. */

import PhoneEnvironment from '@deepseek-ai/dsh-phone-environment'

function required(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

/** Patch the production class before the later Desktop overlay mounts its instance. */
export function apply(ctx) {
  const original = PhoneEnvironment.prototype.selectManagedAsset
  PhoneEnvironment.prototype.selectManagedAsset = function selectManagedAsset(platform, architecture) {
    const pinned = original.call(this, platform, architecture)
    const bytes = Number(required('DSH_PHONE_MANAGED_FIXTURE_BYTES'))
    const sha256 = required('DSH_PHONE_MANAGED_FIXTURE_SHA256')
    if (!Number.isSafeInteger(bytes) || bytes < 1 || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error('managed phone fixture length or SHA-256 is invalid')
    }
    return Object.freeze({
      ...pinned,
      url: required('DSH_PHONE_MANAGED_FIXTURE_URL'),
      bytes,
      sha256,
    })
  }
  ctx.effect(() => () => {
    PhoneEnvironment.prototype.selectManagedAsset = original
  }, 'managed phone environment fixture restore')
}
