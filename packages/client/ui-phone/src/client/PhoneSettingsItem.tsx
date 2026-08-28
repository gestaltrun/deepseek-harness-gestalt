/**
 * Slot occupant for `settings.plugin.item` keyed on `ui-phone`. The card
 * owns its chrome; this wrapper only binds the injected snapshot.
 */
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PhoneSettingsCard } from './PhoneSettingsCard.tsx'
import type { PhoneSettingsCardFace } from './phone-settings-controller.ts'

/** Props the renderer binds for the phone settings card. */
export type PhoneSettingsItemProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<PhoneSettingsCardFace>

/**
 * Render the phone settings card from its injected snapshot.
 * @param props - snapshot hook and the card's callbacks.
 * @returns the card.
 */
export function PhoneSettingsItem(props: PhoneSettingsItemProps) {
  const state = props.usePhoneSettingsCard(snapshot => snapshot)
  return (
    <PhoneSettingsCard
      enabled={state.enabled}
      view={state.view}
      onEnabledChange={props.setEnabled}
      onRedetect={props.redetect}
      onCopy={props.copyCommand}
      onNextAction={props.nextAction}
    />
  )
}
