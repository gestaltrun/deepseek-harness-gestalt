/**
 * First-run prompt to configure any model. Readiness comes from the same
 * provider join as the Models page: any provider the user can already talk to
 * ends the step. A user with none is offered Settings → Models, not a
 * dedicated official-DeepSeek key field.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { onboardingReadiness } from './store.ts'
import type { en } from './locales.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import styles from './DeepSeekOnboardingDialog.module.css'

/** Registration-side dependencies of {@link DeepSeekOnboardingDialog}. */
export interface DeepSeekOnboardingInjected {
  hooks: {
    /** Shared Models-page join state, bound by the slot renderer. */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type DeepSeekOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<DeepSeekOnboardingInjected>

/* v8 ignore next 3 -- closed-union defaults only defend future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected models onboarding state')
}

/**
 * Prompt a first-run user to open Models while no provider can serve requests.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the onboarding modal or null when onboarding needs no intervention.
 */
export function DeepSeekOnboardingDialog(props: DeepSeekOnboardingDialogProps): ReactNode {
  const { complete, openSection, controller, useModels, t } = props
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (readiness.kind === 'provider-ready' || readiness.kind === 'unavailable') complete()
  }, [complete, readiness.kind])

  switch (readiness.kind) {
    case 'loading':
    case 'provider-ready':
    case 'unavailable':
      return null
    case 'needs-config':
      break
    /* v8 ignore next -- every current readiness variant is handled above */
    default:
      return assertNever(readiness)
  }

  return (
    <OnboardingModal title={t('onboardingTitle')}>
      <p className={styles.description}>{t('onboardingDescription')}</p>
      <div className={styles.actions}>
        <Button onClick={() => { complete() }}>{t('onboardingLater')}</Button>
        <Button
          variant="primary"
          className={styles.primary}
          onClick={() => {
            openSection('models')
            complete()
          }}
        >
          {t('onboardingOpen')}
        </Button>
      </div>
    </OnboardingModal>
  )
}
