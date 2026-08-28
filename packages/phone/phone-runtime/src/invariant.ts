/**
 * Package-owned lifecycle invariant for the phone device fleet Service.
 * The asserted relationship: a change notification is published only after a
 * poll discovered a real difference from the currently published listing, and
 * every notification carries exactly the id-level difference its own listing
 * has versus what was published before it.
 * @module @deepseek-ai/dsh-phone-runtime/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { changeSets } from './devices.ts'
import {
  PHONE_RUNTIME_STATE_OWNER,
  phoneRuntimeStateReader,
  phoneRuntimeStateValidator,
  registerPhoneRuntimeStateValidator,
  type PhoneRuntimeStateOwner,
} from './runtime-state.ts'
import type { DeviceId, PhoneDeviceChange, PhoneDeviceList } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-phone-runtime'

/** Cordis companion plugin name. */
export const name = 'phone-runtime-invariant'
/** Services required before this companion can observe its Service generation. */
export const inject = ['invariants']

/**
 * Approve one candidate change only when its added/removed arrays equal the
 * symmetric difference between the previous and candidate listings, and the
 * candidate actually differs.
 * @param previous - Listing published before the candidate, or `undefined` initially.
 * @param candidate - Candidate awaiting publication.
 * @returns the candidate listing, for tracking the next comparison base.
 * @throws an `Error` describing the malformed notification when either property fails;
 *   the Service surfaces that as a loud publication-time failure.
 */
export function assertConsecutiveChange(
  previous: PhoneDeviceList | undefined,
  candidate: PhoneDeviceChange,
): PhoneDeviceList {
  const recomputed = changeSets(previous, candidate.list)
  if (!recomputed.changed) throw malformed('candidate carries no observable difference')
  if (!sameIds(recomputed.added, candidate.added)) {
    throw malformed(`added ${render(candidate.added)} must equal the recomputed ${render(recomputed.added)}`)
  }
  if (!sameIds(recomputed.removed, candidate.removed)) {
    throw malformed(`removed ${render(candidate.removed)} must equal the recomputed ${render(recomputed.removed)}`)
  }
  return candidate.list
}

function malformed(message: string): Error {
  return new Error(`the phone runtime published a malformed change notification: ${message}`)
}

function sameIds(left: readonly DeviceId[], right: readonly DeviceId[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}

function render(ids: readonly DeviceId[]): string {
  return `[${[...ids].map(id => JSON.stringify(id)).join(', ')}]`
}

/** Minimal structural face of the Service carrying the package-private owner symbol. */
interface ServiceWithOwner {
  readonly [PHONE_RUNTIME_STATE_OWNER]?: PhoneRuntimeStateOwner
}

const install: InvariantInstaller = Object.assign((_ctx: Context, fail: InvariantFailure) => {
  const owner = (_ctx.phoneDevices as unknown as ServiceWithOwner | undefined)?.[PHONE_RUNTIME_STATE_OWNER]
  if (owner === undefined) fail('the phone runtime invariant requires its own Service implementation carrying the owner symbol')
  const readPublished = phoneRuntimeStateReader(owner)
  if (readPublished === undefined) fail('the phone runtime invariant requires the Service state reader registration')
  if (phoneRuntimeStateValidator(owner) !== undefined) fail('the phone runtime invariant found an unexpected second validator seat')
  let publishedBefore = readPublished()
  _ctx.effect(() => registerPhoneRuntimeStateValidator(owner, (candidate) => {
    publishedBefore = assertConsecutiveChange(publishedBefore, candidate)
    return undefined
  }), 'phone runtime change validator')
}, { inject: ['phoneDevices'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
