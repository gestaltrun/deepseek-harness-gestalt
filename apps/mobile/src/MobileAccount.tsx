import { useEffect, useState, useSyncExternalStore } from 'react'
import { companionMayMutate, companionRuntime } from './companion-lifecycle.ts'
import type { ReactNode } from 'react'
import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { ACCOUNT_PRIVACY_NOTICE } from '@deepseek-ai/dsh-platform-account/privacy'
import css from './MobileAccount.module.css'
import type { CompanionInteraction } from './companion-approval.ts'
import type { CompanionSessionSummary } from './companion-history.ts'
import { MobileBrowse } from './MobileBrowse.tsx'
import { MobilePairing, type MobilePairingActions } from './MobilePairing.tsx'

/** Mobile Account page props. */
export interface MobileAccountProps {
  /** Current Mobile installation lifecycle controller. */
  installation: PlatformAccountInstallation
  /** Personal Pairing adapter available after the current Installation signs in. */
  pairing?: MobilePairingActions
  /** Desktop-confirmed Companion Surface and mutation callbacks. */
  companionSurface?: {
    desktopName?: string
    sessions: readonly CompanionSessionSummary[]
    onCreate?: (input: { workspace?: string }) => void
    onSubmit?: (sessionId: string, text: string) => void
    onCancel?: (sessionId: string) => void
    onAttach?: (sessionId: string) => void
    streaming?: boolean
    onSettled?: (interaction: CompanionInteraction) => void
  }
}

/** Mobile Account landing with an optional same-installation Personal Pairing projection. */
export function MobileAccount({ installation, pairing, companionSurface }: MobileAccountProps): ReactNode {
  const snapshot = useSyncExternalStore(
    listener => installation.subscribe(listener),
    () => installation.getSnapshot(),
  )
  const companion = companionRuntime()
  const companionState = useSyncExternalStore(
    listener => companion?.subscribe(listener) ?? (() => {}),
    () => companion?.getState(),
  )
  const [accepted, setAccepted] = useState(false)

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

  const signedIn = snapshot.status === 'signed-in' && snapshot.account !== undefined
  return (
    <main className={css.page} data-mobile-platform-account={snapshot.status}>
      <header className={css.header}>
        <div className={css.mark} aria-hidden="true">深</div>
        <div>
          <p className={css.product}>DeepSeek Gestalt</p>
          <h1>{signedIn ? 'Platform Account' : '连接你的 Platform Account'}</h1>
        </div>
      </header>

      {signedIn ? (
        <section className={css.accountCard} aria-label="当前安装账号">
          <img src={snapshot.account?.avatarUrl} alt="" />
          <div className={css.identity}>
            <strong>@{snapshot.account?.githubLogin}</strong>
            <span>GitHub ID {snapshot.account?.githubId}</span>
          </div>
          <span className={css.status}>当前安装</span>
          <button type="button" className={css.secondary} onClick={() => { setAccepted(false); void installation.signOut() }}>
            退出此安装
          </button>
        </section>
      ) : (
        <>
          <section className={css.notice} aria-labelledby="privacy-title">
            <div className={css.noticeHead}>
              <span>授权前必读</span>
              <h2 id="privacy-title">隐私说明 / Privacy notice</h2>
            </div>
            <div className={css.languages}>
              <p lang="zh-CN">{ACCOUNT_PRIVACY_NOTICE.zh}</p>
              <p lang="en">{ACCOUNT_PRIVACY_NOTICE.en}</p>
            </div>
            <dl className={css.retention}>
              <div><dt>GitHub 权限</dt><dd>公开身份 · 无 OAuth scope</dd></div>
              <div><dt>保留期</dt><dd>IP ≤ 7 天 · 安全事件 ≤ 30 天</dd></div>
              <div><dt>账号删除</dt><dd>首个版本暂不提供</dd></div>
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
            <span>我已阅读中英文隐私说明</span>
          </label>
          <button
            type="button"
            className={css.primary}
            disabled={!accepted || snapshot.status !== 'ready'}
            onClick={() => { installation.openLogin() }}
          >
            {snapshot.status === 'preparing'
              ? '准备安全授权…'
              : snapshot.status === 'polling'
                ? '等待 GitHub 授权…'
                : '使用 GitHub 继续'}
          </button>
        </>
      )}
      {snapshot.error !== undefined && <p className={css.error} role="alert">{snapshot.error}</p>}
      {signedIn && pairing !== undefined && <MobilePairing actions={pairing} />}
      {signedIn && companionSurface?.desktopName !== undefined && (
        <MobileBrowse
          desktopName={companionSurface.desktopName}
          connection={companionMayMutate(companionState) ? 'online' : 'offline'}
          sessions={companionSurface.sessions}
          {...(companionState === undefined ? {} : { companionState })}
          {...(companionSurface.onSubmit === undefined ? {} : { onSubmit: companionSurface.onSubmit })}
          {...(companionSurface.onCancel === undefined ? {} : { onCancel: companionSurface.onCancel })}
          {...(companionSurface.onAttach === undefined ? {} : { onAttach: companionSurface.onAttach })}
          {...(companionSurface.streaming === undefined ? {} : { streaming: companionSurface.streaming })}
          {...(companionSurface.onSettled === undefined ? {} : { onSettled: companionSurface.onSettled })}
          {...(companionSurface.onCreate === undefined ? {} : { onCreate: companionSurface.onCreate })}
        />
      )}
      <footer>此账号仅识别你的安装；它不会授予任何 Desktop 访问权限。</footer>
    </main>
  )
}
