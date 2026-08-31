/**
 * Top-level Phone Devices settings section: the six-state environment
 * wizard as the page body. This is not the Plugins card and not Mobile
 * Companion.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PhoneSettingsCard } from './PhoneSettingsCard.tsx'
import { PhoneRuntimeBar } from './PhoneRuntimeBar.tsx'
import { PhonePlatformCards } from './PhonePlatformCards.tsx'
import type { PhoneSettingsCardFace } from './phone-settings-controller.ts'
import css from './PhoneSettingsSection.module.css'

/** Props the renderer binds for the Phone Devices settings section. */
export type PhoneSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.phone-devices'>
  & InjectFace<PhoneSettingsCardFace>

/**
 * Render the Phone Devices settings page.
 * @param props - locale copy, snapshot hook, and the card's callbacks.
 * @returns the section.
 */
export function PhoneSettingsSection(props: PhoneSettingsSectionProps) {
  const state = props.usePhoneSettingsCard(snapshot => snapshot)
  return (
    <section className={css.section} data-phone-settings>
      <h2 className={css.heading}>{props.t('title')}</h2>
      <p className={css.intro}>{props.t('intro')}</p>
      <PhoneRuntimeBar
        runtime={state.runtime}
        onPrepare={props.prepareRuntime}
        onCancel={props.cancelRuntime}
        onRefresh={props.refreshRuntime}
      />
      <PhonePlatformCards
        android={state.platforms.android}
        ios={state.platforms.ios}
        iosUnsupportedMessage={props.t('iosUnsupported')}
        onPrepareAndroid={props.prepareAndroid}
        onCancelAndroid={props.cancelAndroid}
        onRefreshAndroid={props.refreshAndroid}
        onStartAndroid={props.startAndroid}
        onPrepareIos={props.prepareIos}
        onCancelIos={props.cancelIos}
        onRefreshIos={props.refreshIos}
        onStartIos={props.startIos}
      />
      <PhoneSettingsCard
        enabled={state.enabled}
        view={state.view}
        onEnabledChange={props.setEnabled}
        onRedetect={props.redetect}
        onCopy={props.copyCommand}
        onNextAction={props.nextAction}
      />
    </section>
  )
}
