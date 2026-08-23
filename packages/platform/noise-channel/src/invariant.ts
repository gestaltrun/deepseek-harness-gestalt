/** Package-owned invariant companion for the Snow Companion channel. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-noise-channel'

/** Cordis companion plugin name. */
export const name = 'noise-channel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Channel state is checked at its wire and state-machine boundaries. */
const install: InvariantInstaller = () => {
  // No runtime invariant: wire codecs and process-owned state machines reject every invalid relationship synchronously.
}

/** @param ctx - runtime receiving package ownership. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
