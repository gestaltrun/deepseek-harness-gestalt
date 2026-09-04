/**
 * Browser Profile settings section: default create identity and the named
 * persistent roster. The page does not create Browser Workspaces; Dock and
 * `browser_create` read these defaults.
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  isBrowserProfileName,
  type BrowserProfileKindSetting,
  type BrowserSettings,
} from '../browser-settings.ts'
import type { BrowserKey } from './locales.ts'
import css from './BrowserSettingsSection.module.css'

/** Registration-side business face: live preferences + durable writes. */
export interface BrowserSettingsInjected {
  hooks: {
    /** Durable Browser Profile preferences bound as useSettings. */
    settings: SnapshotStore<BrowserSettings>
  }
  /** Persist the omit-profile create identity. */
  setDefaultKind: (kind: BrowserProfileKindSetting) => void
  /** Persist the persistent name used when {@link BrowserSettings.defaultKind} is persistent. */
  setDefaultPersistentName: (name: string) => void
  /** Append one named Profile to the roster. */
  addNamedProfile: (name: string) => void
  /**
   * Replace one roster name. The persistent default follows the rename when
   * it still pointed at the old name.
   */
  renameNamedProfile: (from: string, to: string) => void
  /** Remove one named Profile and clear it as the persistent default when it was selected. */
  removeNamedProfile: (name: string) => void
}

/** Full settings section props. */
export type BrowserSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'browser'>
  & InjectFace<BrowserSettingsInjected>

const KINDS: readonly { id: BrowserProfileKindSetting; labelKey: BrowserKey }[] = [
  { id: 'shared', labelKey: 'settings.kind.shared' },
  { id: 'temporary', labelKey: 'settings.kind.temporary' },
  { id: 'persistent', labelKey: 'settings.kind.persistent' },
]

/**
 * Render the Browser Profile settings section.
 * @param props - composed slot props.
 */
export function BrowserSettingsSection({
  t, useSettings, setDefaultKind, setDefaultPersistentName,
  addNamedProfile, renameNamedProfile, removeNamedProfile,
}: BrowserSettingsSectionProps) {
  const defaultKind = useSettings(s => s.defaultKind)
  const defaultPersistentName = useSettings(s => s.defaultPersistentName)
  const namedProfiles = useSettings(s => s.namedProfiles)
  const [draft, setDraft] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const trimmed = draft.trim()
  const invalid = trimmed.length > 0 && !isBrowserProfileName(trimmed)
  const duplicate = namedProfiles.includes(trimmed)
  const commitRename = (from: string): void => {
    const next = (edits[from] ?? from).trim()
    if (next === from) return
    if (!isBrowserProfileName(next) || namedProfiles.includes(next)) return
    renameNamedProfile(from, next)
  }
  return (
    <section className={css.section} data-browser-settings>
      <h2 className={css.title}>{t('settings.title')}</h2>
      <p className={css.intro}>{t('settings.intro')}</p>
      <div className={css.field}>
        <span id="browser-default-kind">{t('settings.defaultKind')}</span>
        <div className={css.kinds} role="radiogroup" aria-labelledby="browser-default-kind">
          {KINDS.map(({ id, labelKey }) => (
            <label key={id} className={css.row}>
              <input
                type="radio"
                name="browser-default-kind"
                checked={defaultKind === id}
                onChange={() => { setDefaultKind(id) }}
              />
              {t(labelKey)}
            </label>
          ))}
        </div>
      </div>
      {defaultKind === 'persistent'
        ? (
          <label className={css.field}>
            {t('settings.defaultPersistentName')}
            <select
              className={css.control}
              value={defaultPersistentName}
              onChange={(event) => { setDefaultPersistentName(event.target.value) }}
            >
              <option value="">{t('settings.defaultPersistentName.empty')}</option>
              {namedProfiles.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        )
        : null}
      <div className={css.field}>
        <span>{t('settings.roster')}</span>
        {namedProfiles.length === 0
          ? <p className={css.empty}>{t('settings.roster.empty')}</p>
          : (
            <ul className={css.roster}>
              {namedProfiles.map((name) => {
                const value = edits[name] ?? name
                const next = value.trim()
                const renameInvalid = next.length > 0 && !isBrowserProfileName(next)
                const renameDuplicate = next !== name && namedProfiles.includes(next)
                const canRename = next !== name && !renameInvalid && !renameDuplicate
                return (
                  <li key={name} className={css.rosterRow}>
                    <input
                      className={`${css.control} ${css.rosterName}`}
                      type="text"
                      value={value}
                      aria-label={t('settings.roster.name')}
                      aria-invalid={renameInvalid || undefined}
                      onChange={(event) => {
                        setEdits(current => ({ ...current, [name]: event.target.value }))
                      }}
                      onBlur={() => { commitRename(name) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitRename(name)
                        }
                      }}
                    />
                    <span className={css.rosterActions}>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!canRename}
                        onClick={() => { commitRename(name) }}
                      >
                        {t('settings.roster.rename')}
                      </Button>
                      <Button type="button" size="sm" onClick={() => { removeNamedProfile(name) }}>
                        {t('settings.roster.remove')}
                      </Button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        <label className={css.field}>
          {t('settings.roster.add')}
          <input
            className={css.control}
            type="text"
            value={draft}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'browser-profile-name-error' : undefined}
            onChange={(event) => { setDraft(event.target.value) }}
          />
        </label>
        {invalid
          ? (
            <p id="browser-profile-name-error" className={css.error} role="alert">
              {t('settings.roster.invalid')}
            </p>
          )
          : null}
        <Button
          type="button"
          disabled={trimmed.length === 0 || invalid || duplicate}
          onClick={() => {
            addNamedProfile(trimmed)
            setDraft('')
          }}
        >
          {t('settings.roster.submit')}
        </Button>
      </div>
    </section>
  )
}
