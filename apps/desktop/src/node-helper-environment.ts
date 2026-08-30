/** Minimal environment inherited by Desktop's official-Node network helpers. */

/**
 * Retain only certificate and temporary-directory settings needed by a network helper.
 * @param ambient - Desktop process environment.
 * @param additions - test-only overrides such as a local certificate authority.
 * @returns allowlisted child-process environment.
 */
export function desktopNodeHelperEnvironment(
  ambient: Readonly<NodeJS.ProcessEnv>,
  additions: Readonly<NodeJS.ProcessEnv> | undefined,
): NodeJS.ProcessEnv {
  const allowed = [
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
    'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP',
  ] as const
  const result: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = additions?.[name] ?? ambient[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
