/**
 * Package-private publication channel shared by the Service and its invariant
 * companion: the authoritative published listing reader and the synchronous
 * pre-publication validator that must approve every change notification.
 * @module @deepseek-ai/dsh-phone-runtime/runtime-state
 */

import type { PhoneDeviceChange, PhoneDeviceList } from './types.ts'

/** Symbol carried by one concrete Service generation to identify itself. */
export const PHONE_RUNTIME_STATE_OWNER: unique symbol = Symbol('phone-runtime.state-owner')

/** Opaque identity for one concrete Service generation. */
export type PhoneRuntimeStateOwner = object

/** Synchronous read of the currently published device listing, if any. */
export type PhoneRuntimeStateReader = () => PhoneDeviceList | undefined

/**
 * Synchronous pre-publication validation of one candidate change. A validator
 * reports failures through its own {@link import('@deepseek-ai/dsh-invariants').InvariantFailure}
 * closure; it returns `undefined` when the candidate conforms.
 */
export type PhoneRuntimeStateValidator = (candidate: PhoneDeviceChange) => undefined

interface Registration<T> {
  readonly value: T
}

const readers = new WeakMap<PhoneRuntimeStateOwner, Registration<PhoneRuntimeStateReader>>()
const validators = new WeakMap<PhoneRuntimeStateOwner, Registration<PhoneRuntimeStateValidator>>()

/**
 * Register the authoritative listing reader for one Service generation.
 * @param owner - concrete Service generation.
 * @param read - synchronous read of the currently published listing.
 * @returns disposer for this exact registration.
 * @throws when the generation already has a reader.
 */
export function registerPhoneRuntimeStateReader(
  owner: PhoneRuntimeStateOwner,
  read: PhoneRuntimeStateReader,
): () => void {
  if (readers.has(owner)) {
    throw new Error('phone-runtime: the Service generation already registered a state reader')
  }
  const registration = Object.freeze({ value: read })
  readers.set(owner, registration)
  return () => {
    if (readers.get(owner) === registration) readers.delete(owner)
  }
}

/**
 * Resolve the authoritative listing reader for one Service generation.
 * @param owner - concrete Service generation.
 * @returns the registered reader, or `undefined` for a different implementation.
 */
export function phoneRuntimeStateReader(owner: PhoneRuntimeStateOwner): PhoneRuntimeStateReader | undefined {
  return readers.get(owner)?.value
}

/**
 * Register the synchronous pre-publication validator for one Service generation.
 * @param owner - concrete Service generation with an active reader.
 * @param validate - validation run before every candidate publication.
 * @returns disposer for this exact registration.
 * @throws when the reader is missing or the generation already has a validator.
 */
export function registerPhoneRuntimeStateValidator(
  owner: PhoneRuntimeStateOwner,
  validate: PhoneRuntimeStateValidator,
): () => void {
  if (!readers.has(owner)) {
    throw new Error('phone-runtime: the Service generation has no state reader')
  }
  if (validators.has(owner)) {
    throw new Error('phone-runtime: the Service generation already registered a state validator')
  }
  const registration = Object.freeze({ value: validate })
  validators.set(owner, registration)
  return () => {
    if (validators.get(owner) === registration) validators.delete(owner)
  }
}

/**
 * Resolve the pre-publication validator for one Service generation.
 * @param owner - concrete Service generation.
 * @returns the registered validator, or `undefined` when invariant diagnostics are not mounted.
 */
export function phoneRuntimeStateValidator(owner: PhoneRuntimeStateOwner): PhoneRuntimeStateValidator | undefined {
  return validators.get(owner)?.value
}
