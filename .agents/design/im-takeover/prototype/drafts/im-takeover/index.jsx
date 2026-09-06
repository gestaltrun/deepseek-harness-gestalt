import React from 'react'
import { createStore, useStore } from '../../system/store.js'
import { DEFAULT_STATE, PLATFORMS } from '../../fixtures/imData.js'
import { ProtoBar, InjectButton } from '../../system/chrome/chrome.jsx'
import { Toast } from '../../system/components/ui.jsx'
import { AccountsScreen } from './AccountsScreen.jsx'
import { WorkspaceScreen } from './WorkspaceScreen.jsx'
import { SessionScreen } from './SessionScreen.jsx'

const store = createStore(DEFAULT_STATE())

const SCREENS = [
  ['settings', '设置 · IM 账号'],
  ['workspace', '工作区设置'],
  ['session', '会话 · IM 面板'],
]

export function ImTakeover({ onNavigate }) {
  const [state, set] = useStore(store)
  const [screen, setScreen] = React.useState('settings')
  const [toastMsg, setToastMsg] = React.useState(null)
  const [strip, setStrip] = React.useState('live') // 评审辅助：真实面板状态
  const [failNext, setFailNext] = React.useState(false)
  React.useEffect(() => { window.__designFailNext = failNext }, [failNext])
  const toast = React.useCallback(msg => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 2200)
  }, [])
  const reset = () => {
    set(DEFAULT_STATE())
    setStrip('live')
    toast('已重置为初始数据')
  }
  const injectExpired = () => {
    const pf = PLATFORMS.feishu
    set(s => ({ ...s, accounts: [...s.accounts, { id: 'acc-' + Date.now(), platform: 'feishu', name: pf.demoIdentity.name, sub: pf.demoIdentity.sub, connected: true, auto: true, authState: 'expired' }] }))
    toast('已添加一个授权已过期的账号（评审注入）')
  }
  return (
    <div className="draft-root">
      <ProtoBar view="im" setView={onNavigate} onReset={reset}
        injections={failNext}>
        <nav className="proto-screens">
          {SCREENS.map(([id, label]) => (
            <a key={id} className={screen === id ? 'on' : ''} onClick={() => setScreen(id)}>{label}</a>
          ))}
        </nav>
        <span className="sw-label">面板状态：</span>
        {[['live', '接待中'], ['unknown', '发送待确认'], ['disabled', '已停用'], ['offline', '断连']].map(([id, label]) => (
          <button key={id} className={`proto-mini${strip === id ? ' on' : ''}`} onClick={() => setStrip(id)}>{label}</button>
        ))}
        <InjectButton active={failNext} onClick={() => setFailNext(!failNext)} title="评审注入：下一次连接流程显示产品错误与重试">注入：连接失败</InjectButton>
        <InjectButton onClick={injectExpired} title="评审注入：直接添加一个授权已过期的示例账号">注入：过期账号</InjectButton>
        <InjectButton onClick={() => window.dispatchEvent(new Event('design:fill-creds'))} title="评审注入：向千牛凭证表单填入示例凭据（仅示例）">注入：示例凭据</InjectButton>
      </ProtoBar>
      <div className="draft-body">
        {screen === 'settings' && <AccountsScreen state={state} set={set} toast={toast} />}
        {screen === 'workspace' && <WorkspaceScreen state={state} set={set} toast={toast} />}
        {screen === 'session' && <SessionScreen state={state} set={set} toast={toast} strip={strip} setStrip={setStrip} />}
      </div>
      <Toast toast={toastMsg} />
    </div>
  )
}
