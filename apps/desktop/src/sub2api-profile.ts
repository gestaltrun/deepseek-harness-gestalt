/**
 * Profile surgery for the optional Sub2API sidecar component.
 *
 * The installer never shells out to pnpm or the `dsh` CLI: it edits the
 * `web` profile the way `dsh plugin add` would — appending one name to
 * `dsh.profile.bundles` (publish.md semantics: the ordered bundle-layer list;
 * every other manifest entry stays byte-identical) and placing the extracted
 * package under `node_modules/<name>` where the profile's module resolution
 * finds it. Disable/enable reuse the documented user-override lever: a patch
 * row in the profile's own `cordis.patch.yml` that disables the bundle's
 * Loader row by id. The installer only ever writes its own exact rows
 * (`{ id }` plus nothing but `disabled: true`) and refuses to touch rows it
 * does not own.
 * @module @deepseek-ai/dsh-desktop/sub2api-profile
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

/**
 * The entry-list YAML dialect: `!!js` scalars round-trip as Loader expression
 * nodes. This mirrors `entryListSchema` in `@deepseek-ai/cordis-plugin-include`
 * (the authoritative definition, which drags the plugin loader with it); the
 * Electron main process needs only the dialect, so it rebuilds the schema here.
 * Keep the two aligned.
 */
interface JsExprNode {
  __jsExpr: string
}

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data): boolean => typeof data === 'string',
  construct: (data): JsExprNode => ({ __jsExpr: data as string }),
  predicate: (data): boolean => data instanceof Object && '__jsExpr' in data,
  represent: (data): string => (data as JsExprNode).__jsExpr,
})

/** Same dialect the include mounts when composing profile patch layers. */
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

/** The bundle package the offer card installs. */
export const SUB2API_BUNDLE_NAME = 'dsh-sub2api-sidecar'

/** The Loader row id the sidecar bundle's patch layer inserts. */
export const SUB2API_ROW_ID = 'dsh-sub2api-sidecar'

/** The profile manifest slice the installer reads and writes. */
export interface Sub2ApiProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: {
    bundle?: unknown
    profile?: {
      bundles?: string[]
    }
  }
  [key: string]: unknown
}

/** The profile directory paths the installer needs. */
export interface Sub2ApiProfilePaths {
  /** The profile directory (`$DSH_HOME/profiles/web`). */
  readonly dir: string
}

function manifestPath(dir: string): string {
  return `${dir}/package.json`
}

function patchPath(dir: string): string {
  return `${dir}/cordis.patch.yml`
}

/**
 * Read the profile manifest. A missing manifest means the profile was never
 * initialized; the offer card treats that as "not installed" and the installer
 * fails loud rather than creating a profile the Web Host did not boot from.
 * @param dir - the profile directory.
 * @returns the parsed manifest.
 */
export async function readSub2ApiProfileManifest(dir: string): Promise<Sub2ApiProfileManifest> {
  const raw = await readFile(manifestPath(dir), 'utf8')
    .catch((error: unknown) => {
      throw new Error(`Sub2API installer: profile manifest ${manifestPath(dir)} is unreadable: ${String(error)}`)
    })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Sub2API installer: profile manifest ${manifestPath(dir)} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Sub2API installer: profile manifest ${manifestPath(dir)} must hold a JSON object`)
  }
  return parsed as Sub2ApiProfileManifest
}

/**
 * Whether the manifest's `dsh.profile.bundles` already lists the bundle.
 * A missing `dsh` section counts as absent.
 */
export function manifestListsBundle(manifest: Sub2ApiProfileManifest, name: string): boolean {
  return manifest.dsh?.profile?.bundles?.includes(name) ?? false
}

/** Pure manifest transform: append one bundle name unless already present. */
export function manifestWithBundle(manifest: Sub2ApiProfileManifest, name: string): Sub2ApiProfileManifest {
  if (manifestListsBundle(manifest, name)) return manifest
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] },
    },
  }
}

/** Pure manifest transform: drop one bundle name from the layer list. */
export function manifestWithoutBundle(manifest: Sub2ApiProfileManifest, name: string): Sub2ApiProfileManifest {
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles === undefined || !bundles.includes(name)) return manifest
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: bundles.filter(entry => entry !== name) },
    },
  }
}

async function writeProfileManifest(dir: string, manifest: Sub2ApiProfileManifest): Promise<void> {
  await writeFileAtomic(manifestPath(dir), JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
}

/**
 * Append the bundle row to `dsh.profile.bundles` under the profile's
 * cross-process writer lock. Other manifest entries are preserved verbatim.
 * @param dir - the profile directory.
 * @returns true when the row was added, false when it was already present.
 */
export async function addSub2ApiBundleRow(dir: string): Promise<boolean> {
  return await withFileLock(manifestPath(dir), async () => {
    const manifest = await readSub2ApiProfileManifest(dir)
    if (manifestListsBundle(manifest, SUB2API_BUNDLE_NAME)) return false
    await writeProfileManifest(dir, manifestWithBundle(manifest, SUB2API_BUNDLE_NAME))
    return true
  }, { waitMs: 10_000 })
}

/**
 * Remove the bundle row from `dsh.profile.bundles` under the same lock.
 * @param dir - the profile directory.
 * @returns true when the row was removed, false when it was absent.
 */
export async function removeSub2ApiBundleRow(dir: string): Promise<boolean> {
  return await withFileLock(manifestPath(dir), async () => {
    const manifest = await readSub2ApiProfileManifest(dir)
    if (!manifestListsBundle(manifest, SUB2API_BUNDLE_NAME)) return false
    await writeProfileManifest(dir, manifestWithoutBundle(manifest, SUB2API_BUNDLE_NAME))
    return true
  }, { waitMs: 10_000 })
}

/**
 * Restore an exact pre-install manifest document after a failed install.
 * @param dir - the profile directory.
 * @param previousManifest - the manifest text captured before the patch.
 */
export async function restoreSub2ApiProfileManifest(
  dir: string,
  previousManifest: string,
): Promise<void> {
  await writeFileAtomic(manifestPath(dir), previousManifest, { mode: 0o600 })
}

/** The manifest text before a patch, for rollback. */
export async function readProfileManifestText(dir: string): Promise<string> {
  return await readFile(manifestPath(dir), 'utf8')
}

/** Pure patch-list transform: append the exact disable row for `id` unless present. */
export function patchRowsWithDisable(rows: readonly unknown[], id: string): unknown[] {
  if (rows.some(row => isOwnDisableRow(row, id))) return [...rows]
  return [...rows, { id, disabled: true }]
}

/** Pure patch-list transform: remove the exact disable row for `id`. */
export function patchRowsWithoutDisable(rows: readonly unknown[], id: string): unknown[] {
  return rows.filter(row => !isOwnDisableRow(row, id))
}

/** Whether one patch row is exactly the disable row the installer owns. */
export function isOwnDisableRow(row: unknown, id: string): boolean {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  const record = row as Record<string, unknown>
  return record['id'] === id && record['disabled'] === true && Object.keys(record).length === 2
}

/** Whether one patch row targets the id (any other content stays user-owned). */
export function targetsRow(row: unknown, id: string): boolean {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  return (row as Record<string, unknown>)['id'] === id
}

async function readPatchRows(dir: string): Promise<unknown[]> {
  let raw: string
  try {
    raw = await readFile(patchPath(dir), 'utf8')
  } catch {
    // No user patch layer: the profile boots with bundle layers only, so the
    // disable lever writes a fresh single-row file.
    return []
  }
  let parsed: unknown
  try {
    parsed = yaml.load(raw, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`Sub2API installer: profile patch layer ${patchPath(dir)} does not parse: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Sub2API installer: profile patch layer ${patchPath(dir)} must be a top-level YAML array`)
  }
  return parsed as unknown[]
}

async function writePatchRows(dir: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(patchPath(dir), yaml.dump(rows, { schema: entryListSchema, noRefs: true }), { mode: 0o600 })
}

/**
 * Whether the profile's patch layer currently disables the sidecar row.
 * A non-installer row for the same id reports disabled=false; the installer
 * never interprets user-owned rows.
 * @param dir - the profile directory.
 */
export async function isSub2ApiDisabled(dir: string): Promise<boolean> {
  const rows = await readPatchRows(dir)
  return rows.some(row => isOwnDisableRow(row, SUB2API_ROW_ID))
}

/**
 * Add or remove the installer-owned disable row. A user-owned patch row for
 * the same id makes the write fail loud instead of silently replacing it.
 * @param dir - the profile directory.
 * @param disabled - true adds the row, false removes it.
 */
export async function setSub2ApiDisabled(dir: string, disabled: boolean): Promise<void> {
  const rows = await readPatchRows(dir)
  if (rows.some(row => isOwnDisableRow(row, SUB2API_ROW_ID)) === disabled) return
  if (disabled) {
    const foreign = rows.filter(row => targetsRow(row, SUB2API_ROW_ID) && !isOwnDisableRow(row, SUB2API_ROW_ID))
    if (foreign.length > 0) {
      throw new Error(
        `Sub2API installer: your profile patch layer already patches the '${SUB2API_ROW_ID}' row; `
        + 'enable or disable the account pool by editing that row yourself',
      )
    }
  }
  await writePatchRows(dir, disabled ? patchRowsWithDisable(rows, SUB2API_ROW_ID) : patchRowsWithoutDisable(rows, SUB2API_ROW_ID))
}

/**
 * Read the installed bundle's package version from the profile's node_modules.
 * @param dir - the profile directory.
 * @returns the version, or `undefined` when the package directory is absent.
 */
export async function installedBundleVersion(dir: string): Promise<string | undefined> {
  const packagePath = `${dir}/node_modules/${SUB2API_BUNDLE_NAME}/package.json`
  let raw: string
  try {
    raw = await readFile(packagePath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed['version'] === 'string' ? parsed['version'] : undefined
  } catch {
    // An installed package.json that does not parse is a broken install; the
    // controller surfaces the missing version rather than guessing one.
    return undefined
  }
}

/**
 * Whether the bundle package directory exists under the profile.
 * @param dir - the profile directory.
 */
export async function bundlePackageExists(dir: string): Promise<boolean> {
  try {
    return (await stat(`${dir}/node_modules/${SUB2API_BUNDLE_NAME}`)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Remove the extracted bundle package directory (best effort: an absent
 * directory is already the desired state).
 * @param dir - the profile directory.
 */
export async function removeBundlePackage(dir: string): Promise<void> {
  await rm(`${dir}/node_modules/${SUB2API_BUNDLE_NAME}`, { recursive: true, force: true })
}
