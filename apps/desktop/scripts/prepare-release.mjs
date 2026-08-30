#!/usr/bin/env node
/** Validate a Desktop Release dispatch before runners package the bundle. */
import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Derive the tag for one validated Desktop Bundle candidate.
 * @param {{ requestedVersion: string, packageVersion: string, publish: boolean, tagExists: boolean }} input - dispatch and repository state.
 * @returns {{ version: string, tag: string }} validated release identifiers.
 */
export function prepareRelease(input) {
  if (!VERSION_PATTERN.test(input.requestedVersion)) {
    throw new Error(`Desktop Bundle must use the supported X.Y.Z version grammar: ${input.requestedVersion}`)
  }
  if (input.requestedVersion !== input.packageVersion) {
    throw new Error(
      `requested Desktop Bundle ${input.requestedVersion} does not match apps/desktop/package.json ${input.packageVersion}`,
    )
  }

  const tag = `gestalt-v${input.requestedVersion}`
  if (input.publish) {
    if (input.tagExists) throw new Error(`Desktop release tag already exists: ${tag}`)

  }

  return { tag, version: input.requestedVersion }
}

function localTagExists(tag) {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    stdio: 'ignore',
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`could not inspect local tag ${tag}`)
}

if (process.argv[1]?.endsWith('prepare-release.mjs') === true) {
  const [requestedVersion, publishText] = process.argv.slice(2)
  if (requestedVersion === undefined || publishText === undefined) {
    throw new Error('usage: prepare-release.mjs <version> <true|false>')
  }
  if (publishText !== 'true' && publishText !== 'false') {
    throw new Error(`publish must be true or false, received ${publishText}`)
  }

  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const plan = prepareRelease({
    requestedVersion,
    packageVersion: packageJson.version,
    publish: publishText === 'true',
    tagExists: localTagExists(`gestalt-v${requestedVersion}`),
  })
  const output = process.env.GITHUB_OUTPUT
  if (output === undefined) throw new Error('GITHUB_OUTPUT is required')
  appendFileSync(output, `version=${plan.version}\ntag=${plan.tag}\n`)
}
