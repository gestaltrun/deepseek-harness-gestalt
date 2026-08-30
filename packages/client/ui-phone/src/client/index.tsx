/**
 * Phone plugin, browser half: registers the 「手机」 tab type through the
 * `ctx.betterSidebar` service and the top-level 「手机设备」 settings
 * section. The tab type hosts the always-reachable picker instance (the
 * locked not-connected empty state) plus one connected instance per opened
 * device (`phone:<serial>` ids, serial dedupeKey) whose body consumes the
 * Host `phoneStream` same-origin channel. With `enabled: false` (the
 * default) opens of device tabs are refused and no stream session is ever
 * minted.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import z from '@deepseek-ai/schemastery'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PhoneConnectedView } from './PhoneConnectedView.tsx'
import { PhoneTabIcon } from './phone-icon.tsx'
import { PhoneTab } from './PhoneTab.tsx'
import { PhoneSettingsSection } from './PhoneSettingsSection.tsx'
import { PhoneSettingsCardController } from './phone-settings-controller.ts'
import { createListingPhoneEnvironmentSource } from './phone-environment-listing.ts'
import { PhoneConnectionController } from './phone-connection.ts'
import { createHttpPhoneGateway } from './phone-stream-client.ts'
import { createHttpPhoneListingSource } from './phone-listing.ts'
import {
  installPhoneTab, phoneDeviceTabMetaOf,
  type PhoneTabBodyProps, type PhoneTabEnvironment, type PhoneTabView,
} from './registry.ts'
import { en, NS, zh, type PhoneSettingsKey } from './locales.ts'
import { PHONE_SETTINGS_NAMESPACE } from '../phone-settings.ts'
import type { PhoneSettings } from '../phone-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Phone Devices settings section copy. */
    'settings.phone-devices': PhoneSettingsKey
  }
}

/** Services required before activation. */
export const inject = ['betterSidebar', 'slots', 'locale', 'settingsScope'] as const

/**
 * Enable gate of the phone tab. The default stays `false`: a deployment must
 * opt in before any device discovery may run (contract placeholder until the
 * mobilecli ticket wires real detection). The Host `ui-phone` section is the
 * durable copy of this flag; composition Config remains the Loader default.
 */
export interface Config {
  /** Whether this deployment enables phone device detection and streaming. */
  readonly enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/**
 * Split one tab instance onto its body: an instance without device meta is
 * the picker (empty state), one with it is the connected view of that device.
 * @param props - the tab instance props from the better-sidebar render.
 * @param env - the registration environment the descriptor assembled.
 * @returns the body of this tab instance.
 */
function renderPhoneTabBody(props: PhoneTabBodyProps, env: PhoneTabEnvironment): ReactNode {
  const device = phoneDeviceTabMetaOf(props.tab.meta)
  if (device === undefined) {
    return <PhoneTab gate={env.gate} source={env.source} onOpenDevice={env.openDevice} />
  }
  return (
    <PhoneConnectedView
      serial={device.serial}
      name={device.name}
      visible={props.visible}
      source={env.source}
      onOpenDevice={env.openDevice}
      createController={env.createController}
    />
  )
}

/**
 * Client plugin body.
 * @param ctx - client context carrying the betterSidebar and settings services.
 * @param config - validated {@link Config} (schema defaults applied).
 */
export function apply(ctx: ClientContext, config: Config): void {
  const compositionEnabled = config.enabled === true
  const scope = ctx.settingsScope.bind<PhoneSettings>({ namespace: PHONE_SETTINGS_NAMESPACE })
  const listing = createHttpPhoneListingSource()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-phone: settings dictionaries')
  const card = new PhoneSettingsCardController(
    scope,
    createListingPhoneEnvironmentSource(listing),
    globalThis.navigator?.clipboard,
  )
  ctx.effect(() => () => { card.dispose() }, 'ui-phone: settings section')

  const tabEnabled = (): boolean => {
    const snapshot = scope.getSnapshot()
    if (snapshot.status === 'ready' && snapshot.value !== undefined) return snapshot.value.enabled === true
    return compositionEnabled
  }
  // The body reads the gate reactively: scope invalidation (the enable
  // switch toggling) re-renders the gate strip on the same tick.
  const gate = { snapshot: tabEnabled, subscribe: (listener: () => void) => scope.subscribe(listener) }
  const view: PhoneTabView = {
    icon: size => <PhoneTabIcon size={size} />,
    component: renderPhoneTabBody,
  }
  installPhoneTab(ctx, {
    source: listing,
    view,
    isEnabled: tabEnabled,
    gate,
    createController: serial => new PhoneConnectionController({
      gateway: createHttpPhoneGateway(),
      deviceId: serial,
    }),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'phone-devices',
    order: 40,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => card.inject(),
  }, PhoneSettingsSection))
}
