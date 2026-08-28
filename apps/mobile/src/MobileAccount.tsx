import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { ACCOUNT_PRIVACY_NOTICE } from '@deepseek-ai/dsh-platform-account/privacy'
import type { SessionListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import css from './MobileAccount.module.css'
import type { MobileCompanionPresentation } from './companion-history.ts'
import type { MobilePairingSnapshot } from './personal-pairing-model.ts'
import { MobileBrowse } from './MobileBrowse.tsx'
import { MobilePairing, type MobilePairingActions } from './MobilePairing.tsx'
import type { MobilePresentationClock } from './mobile-clock.ts'

const EMPTY_SESSIONS: SessionListState = {
  ids: [],
  byId: {},
  current: undefined,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}
const EMPTY_WORKSPACES: readonly WorkspaceView[] = []
const EMPTY_CONVERSATIONS = {}
const EMPTY_SEARCH = { query: '', status: 'idle', items: [], hasMore: false } as const
const MOBILE_LOCALE_STORAGE_KEY = 'dsh-mobile-locale'

/** Signed-in Mobile surface after Platform Account login. */
type SignedInScreen = 'home' | 'account' | 'pairing'

/** Mobile Account page props. */
export interface MobileAccountProps {
  /** Current Mobile installation lifecycle controller. */
  installation: PlatformAccountInstallation
  /** Personal Pairing adapter available after the current Installation signs in. */
  pairing?: MobilePairingActions
  /** Desktop-authoritative Companion presentation supplied by the product entry. */
  companion?: MobileCompanionPresentation | undefined
  /** Initial product locale used when the Account page has no persisted selection. */
  locale: 'zh' | 'en'
  /** Product theme shared by Mobile browse and conversation presentation. */
  theme: 'light' | 'dark'
  /** Live clock owner shared by every Session list. */
  clock: MobilePresentationClock
}

/** Mobile Account login followed by separate Account, Pairing, browse, search, create, and detail surfaces. */
export function MobileAccount({ installation, pairing, companion, locale, theme, clock }: MobileAccountProps): ReactNode {
  const snapshot = useSyncExternalStore(
    listener => installation.subscribe(listener),
    () => installation.getSnapshot(),
  )
  const pairingSnapshot = useSyncExternalStore(
    listener => pairing?.subscribe(listener) ?? (() => {}),
    () => pairing?.getSnapshot(),
  )
  const [accepted, setAccepted] = useState(false)
  const [screen, setScreen] = useState<SignedInScreen>('home')
  const [activeLocale, setActiveLocale] = useState<'zh' | 'en'>(() => storedLocale(locale))

  useEffect(() => { void installation.load() }, [installation])
  useEffect(() => {
    if (snapshot.status !== 'polling') return
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const result = await installation.pollLogin()
        if (!stopped && result.status === 'pending') window.setTimeout(() => { void poll() }, 1500)
      } catch {
        // The controller publishes the actionable failure message.
      }
    }
    void poll()
    return () => { stopped = true }
  }, [installation, snapshot.status])
  useEffect(() => {
    if (snapshot.status !== 'signed-in' || pairing === undefined) return
    void pairing.activate().catch(reportPairingLifecycleError)
    return () => {
      void pairing.deactivate().catch(reportPairingLifecycleError)
    }
  }, [pairing, snapshot.status])
  useEffect(() => {
    if (snapshot.status !== 'signed-in') setScreen('home')
  }, [snapshot.status])
  useEffect(() => {
    if (pairingSnapshot?.status === 'paired') {
      setScreen(current => current === 'pairing' ? 'home' : current)
    }
  }, [pairingSnapshot?.status])

  const account = snapshot.status === 'signed-in' ? snapshot.account : undefined
  const signedIn = account !== undefined
  const signOut = (): void => {
    setAccepted(false)
    setScreen('home')
    void installation.signOut()
  }
  const selectLocale = (next: 'zh' | 'en'): void => {
    setActiveLocale(next)
    try {
      localStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, next)
    } catch {
      // Browser storage refusal leaves the selected language active for this mounted application.
    }
  }

  if (!signedIn) {
    const text = LOGIN_TEXT[activeLocale]
    return (
      <main className={css.page} data-mobile-platform-account={snapshot.status} lang={activeLocale === 'zh' ? 'zh-CN' : 'en'}>
        <header className={css.header}>
          <div className={css.mark} aria-hidden="true">獭</div>
          <div>
            <p className={css.product}>獭子哥</p>
            <h1>{text.title}</h1>
          </div>
        </header>
        <section className={css.notice} aria-labelledby="privacy-title">
          <div className={css.noticeHead}>
            <span>{text.readBefore}</span>
            <h2 id="privacy-title">{text.privacyNotice}</h2>
          </div>
          <div className={css.languages}>
            <p lang="zh-CN">{ACCOUNT_PRIVACY_NOTICE.zh}</p>
            <p lang="en">{ACCOUNT_PRIVACY_NOTICE.en}</p>
          </div>
          <dl className={css.retention}>
            <div><dt>{text.githubAccess}</dt><dd>{text.githubAccessValue}</dd></div>
            <div><dt>{text.retention}</dt><dd>{text.retentionValue}</dd></div>
            <div><dt>{text.accountDeletion}</dt><dd>{text.accountDeletionValue}</dd></div>
          </dl>
        </section>
        <label className={css.consent}>
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => {
              setAccepted(event.target.checked)
              if (event.target.checked) {
                installation.acceptPrivacy()
                void installation.prepareLogin()
              }
            }}
          />
          <span>{text.consent}</span>
        </label>
        <button
          type="button"
          className={css.primary}
          disabled={!accepted || snapshot.status !== 'ready'}
          onClick={() => { installation.openLogin() }}
        >
          {snapshot.status === 'preparing'
            ? text.preparing
            : snapshot.status === 'polling'
              ? text.polling
              : text.continue}
        </button>
        {snapshot.error !== undefined && <p className={css.error} role="alert">{snapshot.error}</p>}
        <footer>{text.footer}</footer>
      </main>
    )
  }

  if (screen === 'account') {
    return (
      <main className={css.companion} data-mobile-platform-account={snapshot.status}>
        <AccountView
          login={account.githubLogin}
          githubId={account.githubId}
          avatarUrl={account.avatarUrl}
          pairing={pairingSnapshot}
          locale={activeLocale}
          onLocaleChange={selectLocale}
          onBack={() => { setScreen('home') }}
          onSignOut={signOut}
          {...(pairing === undefined ? {} : { onOpenPairing: () => { setScreen('pairing') } })}
          {...(companion?.onClearCache === undefined ? {} : { onClearCache: companion.onClearCache })}
        />
      </main>
    )
  }

  if (screen === 'pairing' && pairing !== undefined) {
    return (
      <main className={css.companion} data-mobile-platform-account={snapshot.status}>
        <section className={css.pairingPage} aria-label={activeLocale === 'zh' ? '配对' : 'Pairing'}>
          <ScreenHeader title={activeLocale === 'zh' ? '配对' : 'Pairing'} onBack={() => { setScreen('home') }} locale={activeLocale} />
          <MobilePairing actions={pairing} locale={activeLocale} manageLifecycle={false} />
        </section>
      </main>
    )
  }

  const selectedDesktop = selectedPairedDesktop(pairingSnapshot)
  const connection = selectedDesktop === undefined
    ? 'unpaired'
    : companion?.connection ?? 'offline'
  return (
    <main className={css.companion} data-mobile-platform-account={snapshot.status}>
      {snapshot.error !== undefined && <p className={css.banner} role="alert">{snapshot.error}</p>}
      {pairingSnapshot?.status === 'unavailable' && <p className={css.banner} role="alert">{pairingSnapshot.error}</p>}
      {companion !== undefined && 'message' in companion.attachment
        && <p className={css.banner} role="alert">{companion.attachment.message}</p>}
      <MobileBrowse
        {...(companion === undefined ? {} : companion)}
        desktopName={companion?.desktopName ?? selectedDesktop?.desktopName}
        connection={connection}
        onOpenAccount={() => { setScreen('account') }}
        {...(pairing === undefined || selectedDesktop !== undefined
          ? {}
          : { onOpenPairing: () => { setScreen('pairing') } })}
        sessions={companion?.sessions ?? EMPTY_SESSIONS}
        workspaces={companion?.workspaces ?? EMPTY_WORKSPACES}
        conversations={companion?.conversations ?? EMPTY_CONVERSATIONS}
        loadImage={companion?.loadImage ?? unavailableImageLoader}
        canMutate={companion?.canMutate ?? false}
        search={companion?.search ?? EMPTY_SEARCH}
        locale={activeLocale}
        theme={theme}
        clock={clock}
      />
    </main>
  )
}

const LOGIN_TEXT = {
  zh: {
    title: '连接你的 Platform Account',
    readBefore: '授权前必读',
    privacyNotice: '隐私说明 / Privacy notice',
    githubAccess: 'GitHub 权限',
    githubAccessValue: '公开身份 · 无 OAuth scope',
    retention: '保留期',
    retentionValue: 'IP ≤ 7 天 · 安全事件 ≤ 30 天',
    accountDeletion: '账号删除',
    accountDeletionValue: '首个版本暂不提供',
    consent: '我已阅读中英文隐私说明',
    preparing: '准备安全授权…',
    polling: '等待 GitHub 授权…',
    continue: '使用 GitHub 继续',
    footer: '这个账号只用于确认你的身份，不会自动允许手机访问桌面端。',
  },
  en: {
    title: 'Connect your Platform Account',
    readBefore: 'Read before authorization',
    privacyNotice: 'Privacy notice',
    githubAccess: 'GitHub access',
    githubAccessValue: 'Public identity · no OAuth scopes',
    retention: 'Retention',
    retentionValue: 'IP ≤ 7 days · security events ≤ 30 days',
    accountDeletion: 'Account deletion',
    accountDeletionValue: 'Not available in the first release',
    consent: 'I have read both privacy notices',
    preparing: 'Preparing secure authorization…',
    polling: 'Waiting for GitHub authorization…',
    continue: 'Continue with GitHub',
    footer: 'This account identifies only this installation; it grants no Desktop access.',
  },
} as const

function AccountView({
  login,
  githubId,
  avatarUrl,
  pairing,
  locale,
  onBack,
  onSignOut,
  onLocaleChange,
  onOpenPairing,
  onClearCache,
}: {
  login: string
  githubId: number
  avatarUrl: string
  pairing: MobilePairingSnapshot | undefined
  locale: 'zh' | 'en'
  onBack: () => void
  onSignOut: () => void
  onLocaleChange: (locale: 'zh' | 'en') => void
  onOpenPairing?: () => void
  onClearCache?: () => void | Promise<void>
}): ReactNode {
  const text = locale === 'zh'
    ? {
      account: '账号', signedInAccount: '已登录账号',
      language: '语言', managePairing: '管理配对', connectDesktop: '连接桌面端',
      clearCache: '清除此桌面端缓存', signOut: '退出登录',
    }
    : {
      account: 'Account', signedInAccount: 'Signed-in account',
      language: 'Language', managePairing: 'Manage pairing', connectDesktop: 'Connect Desktop',
      clearCache: 'Clear this Desktop cache', signOut: 'Sign out',
    }
  return (
    <section className={css.accountPage} aria-label={text.signedInAccount}>
      <ScreenHeader title={text.account} onBack={onBack} locale={locale} />
      <div className={css.accountIdentity} data-account-identity="">
        <img src={avatarUrl} alt="" />
        <div className={css.identity}>
          <strong>@{login}</strong>
          <span>GitHub ID {githubId}</span>
        </div>
      </div>
      <div className={css.languageSetting}>
        <span>{text.language}</span>
        <div className={css.languageOptions} role="group" aria-label={text.language}>
          <button type="button" aria-pressed={locale === 'zh'} onClick={() => { onLocaleChange('zh') }}>中文</button>
          <button type="button" aria-pressed={locale === 'en'} onClick={() => { onLocaleChange('en') }}>English</button>
        </div>
      </div>
      {pairing?.status === 'unavailable' && <p className={css.error} role="alert">{pairing.error}</p>}
      {onOpenPairing !== undefined && (
        <button type="button" className={css.secondary} onClick={onOpenPairing}>
          {pairing?.status === 'paired' ? text.managePairing : text.connectDesktop}
        </button>
      )}
      {onClearCache !== undefined && (
        <button type="button" className={css.secondary} onClick={() => { void onClearCache() }}>{text.clearCache}</button>
      )}
      <button type="button" className={css.secondary} onClick={onSignOut}>{text.signOut}</button>
    </section>
  )
}

function ScreenHeader({ title, onBack, locale = 'zh' }: {
  title: string
  onBack: () => void
  locale?: 'zh' | 'en'
}): ReactNode {
  return (
    <header className={css.screenHeader}>
      <button type="button" className={css.sheetClose} onClick={onBack}>{locale === 'zh' ? '返回' : 'Back'}</button>
      <h1>{title}</h1>
      <span aria-hidden="true" />
    </header>
  )
}

function selectedPairedDesktop(snapshot: MobilePairingSnapshot | undefined):
  { pairingId: string; desktopName?: string } | undefined {
  if (snapshot?.status !== 'paired' || snapshot.selectedPairingId === undefined) return undefined
  return snapshot.desktops.find(desktop => desktop.pairingId === snapshot.selectedPairingId)
}

function unavailableImageLoader(): Promise<string> {
  return Promise.reject(new Error('No Paired Desktop image authority is available'))
}

function reportPairingLifecycleError(error: unknown): void {
  console.error('[mobile-personal-pairing] lifecycle failure:', error)
}

function storedLocale(fallback: 'zh' | 'en'): 'zh' | 'en' {
  try {
    const stored = localStorage.getItem(MOBILE_LOCALE_STORAGE_KEY)
    return stored === 'zh' || stored === 'en' ? stored : fallback
  } catch {
    return fallback
  }
}
