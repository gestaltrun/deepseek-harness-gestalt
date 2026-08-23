// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { BrowserSettingsSection, type BrowserSettingsSectionProps } from '../src/client/BrowserSettingsSection.tsx'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '../src/browser-settings.ts'

function renderSection(
  state: BrowserSettings,
  actions: Pick<
    BrowserSettingsSectionProps,
    'setDefaultKind' | 'setDefaultPersistentName' | 'addNamedProfile' | 'removeNamedProfile'
  >,
) {
  return render(
    <BrowserSettingsSection {...{
      useSettings: <T,>(select: (prefs: BrowserSettings) => T) => select(state),
      t: (key: string) => key,
      ...actions,
    } as unknown as BrowserSettingsSectionProps} />,
  )
}

describe('BrowserSettingsSection', () => {
  it('writes the default identity and adds a valid roster name', () => {
    const setDefaultKind = vi.fn()
    const setDefaultPersistentName = vi.fn()
    const addNamedProfile = vi.fn()
    const removeNamedProfile = vi.fn()
    const view = renderSection(DEFAULT_BROWSER_SETTINGS, {
      setDefaultKind, setDefaultPersistentName, addNamedProfile, removeNamedProfile,
    })
    fireEvent.click(view.getByLabelText('settings.kind.temporary'))
    expect(setDefaultKind).toHaveBeenCalledWith('temporary')
    fireEvent.change(view.getByLabelText('settings.roster.add'), { target: { value: 'work' } })
    fireEvent.click(view.getByText('settings.roster.submit'))
    expect(addNamedProfile).toHaveBeenCalledWith('work')
    view.unmount()
  })

  it('shows the persistent name picker and rejects an invalid draft', () => {
    const setDefaultKind = vi.fn()
    const setDefaultPersistentName = vi.fn()
    const addNamedProfile = vi.fn()
    const removeNamedProfile = vi.fn()
    const view = renderSection({
      defaultKind: 'persistent',
      defaultPersistentName: 'work',
      namedProfiles: ['work'],
    }, { setDefaultKind, setDefaultPersistentName, addNamedProfile, removeNamedProfile })
    fireEvent.change(view.getByLabelText('settings.defaultPersistentName'), { target: { value: '' } })
    expect(setDefaultPersistentName).toHaveBeenCalledWith('')
    fireEvent.click(view.getByText('settings.roster.remove'))
    expect(removeNamedProfile).toHaveBeenCalledWith('work')
    fireEvent.change(view.getByLabelText('settings.roster.add'), { target: { value: 'tmp' } })
    expect(view.getByRole('alert').textContent).toBe('settings.roster.invalid')
    expect((view.getByText('settings.roster.submit') as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
  })
})
