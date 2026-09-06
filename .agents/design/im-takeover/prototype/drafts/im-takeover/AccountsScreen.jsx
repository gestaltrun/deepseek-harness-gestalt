import React from 'react'
import { Button, Input, Modal, IconPlusOutline16 } from '../../system/components/primitives.js'
import { Switch, Pill, PlatformIcon, Spinner, ConfirmStrip } from '../../system/components/ui.jsx'
import { SettingsShell } from '../../system/chrome/chrome.jsx'
import { PLATFORMS } from '../../fixtures/imData.js'

/** 添加账号弹窗：分平台产品化分步流程（千牛为凭证表单）。凭证仅临时内存，关窗清空。 */
function AddAccountModal({ open, onClose, onAdd, injectFail, consumeFail, toast }) {
  const [platform, setPlatform] = React.useState(null)
  const [step, setStep] = React.useState(0) // -1 = 平台选择
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [creds, setCreds] = React.useState({ endpoint: '', accessKey: '', secretKey: '' })
  const [showSecret, setShowSecret] = React.useState(false)
  React.useEffect(() => {
    if (open) { setPlatform(null); setStep(-1); setError(null); setBusy(false); setCreds({ endpoint: '', accessKey: '', secretKey: '' }) }
  }, [open])
  const pf = platform ? PLATFORMS[platform] : null
  const flow = pf ? pf.flow : []
  const st = flow[step]

  const finish = () => {
    setBusy(true)
    setTimeout(() => {
      onAdd(platform, 'ok')
      onClose()
      setBusy(false)
    }, 700)
  }
  const advance = () => {
    if (st.wait) {
      setBusy(true)
      setTimeout(() => {
        setBusy(false)
        if (st.canFail && consumeFail()) { if (st.form) setCreds(c => ({ ...c, secretKey: '' })); setError(st.error); return }
        if (st.form) setCreds({ endpoint: '', accessKey: '', secretKey: '' })
        setError(null); setStep(step + 1)
      }, 800)
      return
    }
    if (step < flow.length - 1) { setError(null); setStep(step + 1); return }
    finish()
  }
  const validateForm = () => {
    if (!creds.endpoint) return '请填写接入点。'
    if (!/^https?:\/\/.+/.test(creds.endpoint)) return '接入点格式不正确。'
    if (!creds.accessKey) return '请填写 AccessKey。'
    if (!/^[A-Za-z0-9-]{4,}$/.test(creds.accessKey)) return 'AccessKey 格式不正确。'
    if (!creds.secretKey) return '请填写 SecretKey。'
    if (creds.secretKey.length < 4) return 'SecretKey 长度不足。'
    return null
  }
  const next = () => {
    if (st.form) {
      const msg = validateForm()
      if (msg) { setError(msg); return }
    }
    advance()
  }
  const fillExample = () => setCreds({ endpoint: 'https://openapi.example.internal', accessKey: 'ak-demo-0001', secretKey: 'demo-secret-placeholder' })
  React.useEffect(() => {
    const h = () => { if (open && platform === 'qianniu' && step === 0) fillExample() }
    window.addEventListener('design:fill-creds', h)
    return () => window.removeEventListener('design:fill-creds', h)
  }, [open, platform, step])

  return (
    <Modal open={open} onClose={onClose} title="添加 IM 账号" className="acct-modal">
      {step === -1 && (
        <div>
          <div className="section-desc" style={{ marginBottom: 12 }}>选择平台。同一平台可以添加多个账号。</div>
          <div className="pf-pick">
            {Object.entries(PLATFORMS).map(([id, p]) => (
              <button key={id} className={`pf-card${platform === id ? ' on' : ''}`} onClick={() => setPlatform(id)}>
                <PlatformIcon pf={p} />{p.name}<span className="d">可添加多个账号</span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" disabled={!platform} onClick={() => setStep(0)}>下一步</Button>
          </div>
        </div>
      )}
      {st && (
        <div>
          <div className="hint" style={{ marginBottom: 10 }}>第 {step + 1} 步，共 {flow.length} 步</div>
          <div className="section-h" style={{ fontSize: 15 }}>{st.title}</div>
          <div className="section-desc" style={{ marginBottom: 14 }}>{st.desc}</div>
          {st.form && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '14px 0 4px' }}>
              <label className="hint">接入点
                <Input placeholder="例如 https://openapi.example.internal" value={creds.endpoint} onChange={e => setCreds({ ...creds, endpoint: e.target.value })} />
              </label>
              <label className="hint">AccessKey
                <Input placeholder="例如 ak-demo-0001" value={creds.accessKey} onChange={e => setCreds({ ...creds, accessKey: e.target.value })} />
              </label>
              <label className="hint">SecretKey
                <span style={{ display: 'flex', gap: 6 }}>
                  <span style={{ flex: 1 }}><Input type={showSecret ? 'text' : 'password'} placeholder="示例占位，不保存" value={creds.secretKey} onChange={e => setCreds({ ...creds, secretKey: e.target.value })} /></span>
                  <Button variant="outline" size="sm" onClick={() => setShowSecret(!showSecret)}>{showSecret ? '隐藏' : '显示'}</Button>
                </span>
              </label>
            </div>
          )}
          {st.identity && (
            <div className="acct-card" style={{ maxWidth: 'none', margin: '14px 0 4px' }}>
              <PlatformIcon pf={pf} />
              <div className="acct-meta">
                <div className="acct-name">{pf.name} · {pf.demoIdentity.name}</div>
                <div className="acct-sub">{pf.demoIdentity.sub}</div>
              </div>
            </div>
          )}
          {error && <div className="banner banner-error" style={{ maxWidth: 'none', margin: '0 0 12px' }}><span>⚠</span><span>{error}</span></div>}
          {busy
            ? <div className="connect-loading"><Spinner /> {st.wait || '正在完成…'}</div>
            : (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
                <Button variant="outline" onClick={() => { setError(null); step === 0 ? setStep(-1) : setStep(step - 1) }}>{step === 0 ? '上一步' : '返回'}</Button>
                <Button variant="primary" onClick={next}>{error ? '重试' : st.action}</Button>
              </div>
            )}
        </div>
      )}
    </Modal>
  )
}

export function AccountsScreen({ state, set, toast, expiredTick }) {
  const [modalOpen, setModalOpen] = React.useState(false)
  const [confirmId, setConfirmId] = React.useState(null)
  const setAccounts = fn => set(s => ({ ...s, accounts: fn(s.accounts) }))

  const toggleAuto = (id, on) => {
    setAccounts(list => list.map(a => a.id === id ? { ...a, auto: on } : a))
    const a = state.accounts.find(x => x.id === id)
    toast(on ? `${a.name}：自动处理已恢复（只恢复原本启用的规则）` : `${a.name}：自动处理已暂停，绑定全部保留`)
  }
  const doDisconnect = id => {
    setAccounts(list => list.map(a => a.id === id ? { ...a, connected: false } : a))
    setConfirmId(null)
    toast(`${state.accounts.find(x => x.id === id).name} 已断开`)
  }
  const reconnect = id => {
    setAccounts(list => list.map(a => a.id === id ? { ...a, connected: true } : a))
    toast(`${state.accounts.find(x => x.id === id).name} 已重新连接`)
  }
  const reauth = id => {
    setAccounts(list => list.map(a => a.id === id ? { ...a, authState: 'ok' } : a))
    toast(`${state.accounts.find(x => x.id === id).name} 已完成重新授权`)
  }
  const onAdd = (platform, authState) => {
    const pf = PLATFORMS[platform]
    setAccounts(list => [...list, { id: 'acc-' + Date.now(), platform, name: pf.demoIdentity.name, sub: pf.demoIdentity.sub, connected: true, auto: true, authState }])
    toast(`${pf.name} · ${pf.demoIdentity.name} 已添加`)
  }

  return (
    <SettingsShell activeId="IM 账号" actions={<button className="modal-close" aria-label="关闭设置">×</button>}>
      <div className="section-h">IM 账号</div>
      <div className="section-desc">连接用于接管的 IM 账号，同一平台可添加多个。会话由哪个工作区接管，在「工作区设置 → IM 接管」中配置。</div>
      <div id="acctList">
        {state.accounts.length === 0 && (
          <div className="empty-block">
            <div className="t">尚未连接任何 IM 账号</div>
            <div style={{ marginBottom: 14 }}>连接账号后，到「工作区设置 → IM 接管」选择要接管的群或单聊。</div>
            <Button variant="primary" icon={<IconPlusOutline16 size={14} />} onClick={() => setModalOpen(true)}>连接 IM 账号</Button>
          </div>
        )}
        {state.accounts.map(a => {
          const pf = PLATFORMS[a.platform]
          const expired = a.authState === 'expired'
          const usable = a.connected && !expired
          return (
            <div key={a.id} className={`acct-card${usable ? '' : ' off'}`} data-acct={a.id}>
              <PlatformIcon pf={pf} />
              <div className="acct-meta">
                <div className="acct-name">{pf.name} · {a.name}{' '}
                  {expired ? <Pill kind="red" dot>授权已过期</Pill>
                    : !a.connected ? <Pill kind="gray">未连接</Pill>
                    : a.auto ? <Pill kind="green" dot>已连接</Pill>
                    : <Pill kind="yellow" dot>自动处理已暂停</Pill>}
                </div>
                <div className="acct-sub">认证方式：{pf.authPath}</div>
                <div className="acct-sub">{a.sub}{usable ? ' · 最近同步 几秒前' : expired ? ' · 需重新完成授权后才能收发' : ' · 规则与历史已保留'}</div>
                {confirmId === a.id && (
                  <div style={{ marginTop: 8 }}>
                    <ConfirmStrip danger confirmText="确认断开" onCancel={() => setConfirmId(null)} onConfirm={() => doDisconnect(a.id)}>
                      断开后该账号的 {state.routes.filter(r => r.accountId === a.id).length} 条路由规则保留，但不再接收新消息。可随时重新连接。
                    </ConfirmStrip>
                  </div>
                )}
              </div>
              <div className="acct-acts">
                <span className="sw-wrap">自动处理
                  <Switch checked={a.auto} disabled={!usable} label={`${pf.name} · ${a.name} 自动处理`} onChange={on => toggleAuto(a.id, on)} />
                </span>
                {expired
                  ? <Button variant="primary" size="sm" onClick={() => reauth(a.id)}>重新授权</Button>
                  : a.connected
                    ? <Button variant="outline" size="sm" onClick={() => setConfirmId(a.id)}>断开连接</Button>
                    : <Button variant="primary" size="sm" onClick={() => reconnect(a.id)}>重新连接</Button>}
              </div>
            </div>
          )
        })}
      </div>
      {state.accounts.length > 0 && (
        <Button variant="primary" icon={<IconPlusOutline16 size={14} />} onClick={() => setModalOpen(true)}>添加 IM 账号</Button>
      )}
      <div className="legend">「自动处理」是账号级总开关：暂停后停止触发 Agent，绑定全部保留，恢复时只恢复原本启用的规则；不阻止手动发送。</div>
      <AddAccountModal open={modalOpen} onClose={() => setModalOpen(false)} onAdd={onAdd}
        consumeFail={() => { const armed = window.__designFailNext; window.__designFailNext = false; window.dispatchEvent(new Event('design:fail-consumed')); return armed }}
        toast={toast} />
    </SettingsShell>
  )
}
