/** Desktop startup ordering between Web Host authority and Personal Pairing Relay access. */

/**
 * Start Personal Pairing only after the signed-in Desktop has installed its Web Host authority.
 * @param input - current Account, Host, and pairing-start owners.
 * @returns whether the pairing owner was started.
 */
export async function startDesktopPairingWhenHostReady(input: {
  accountSignedIn: boolean
  hostReady: boolean
  start(): Promise<void>
}): Promise<boolean> {
  if (!input.accountSignedIn || !input.hostReady) return false
  await input.start()
  return true
}
