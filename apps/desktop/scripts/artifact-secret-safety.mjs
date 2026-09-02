import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu

/**
 * Remove inherited credential values and credential file references.
 * @param {NodeJS.ProcessEnv} source - Ambient environment.
 * @returns {NodeJS.ProcessEnv} Credential-free child environment.
 */
export function credentialSafeEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)))
}

/**
 * Return every non-empty string copied from a credential document.
 * @param {unknown} value - Parsed credential document.
 * @returns {string[]} Unique credential values.
 */
export function credentialValues(value) {
  const values = []
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (current.length > 0) values.push(current)
    } else if (Array.isArray(current)) {
      pending.push(...current)
    } else if (typeof current === 'object' && current !== null) {
      pending.push(...Object.values(current))
    }
  }
  return [...new Set(values)]
}

/**
 * Reject when any artifact file contains a copied credential value.
 * @param {string} root - Artifact directory.
 * @param {string[]} secrets - Credential values that must be absent.
 * @returns {Promise<void>} Completion after every artifact file is scanned.
 */
export async function assertArtifactSecretsAbsent(root, secrets) {
  const needles = secrets.map(secret => Buffer.from(secret))
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        const contents = await readFile(path)
        if (needles.some(needle => contents.includes(needle))) {
          throw new Error(`artifact contains a copied credential value: ${path.slice(root.length + 1)}`)
        }
      }
    }
  }
}
