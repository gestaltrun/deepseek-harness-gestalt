import React from 'react'
import { Button, Input, IconEditOutline16, IconTrashOutline16, IconPlusOutline16 } from '../../system/components/primitives.js'
import { Switch, Pill, PlatformIcon, ConfirmStrip, Banner } from '../../system/components/ui.jsx'
import { LeftNav, WorkspaceSettingsModal } from '../../system/chrome/chrome.jsx'
import { PLATFORMS, CONFLICT_MAP } from '../../fixtures/imData.js'

const pfOf = (state, accountId) => {
  const a = state.accounts.find(x => x.id === accountId)
  return a ? { account: a, pf: PLATFORMS[a.platform] } : { account: null, pf: null }
}

function TriggerBlock({ trig, setTrig, error }) {
  return (
    <div className="rf-triggers">
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>触发方式</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input type="checkbox" checked={trig.mention} onChange={e => setTrig({ ...trig, mention: e.target.checked })} /> 被 @ 时触发
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input type="checkbox" checked={trig.everyN != null} onChange={e => setTrig({ ...trig, everyN: e.target.checked ? (trig.everyN || 10) : null })} /> 每
          <Input type="number" min="1" step="1" style={{ width: 64 }} value={trig.everyN ?? 10} onChange={e => setTrig({ ...trig, everyN: e.target.value === '' ? null : Number(e.target.value) })} /> 条新消息触发
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input type="checkbox" checked={trig.intervalMin != null} onChange={e => setTrig({ ...trig, intervalMin: e.target.checked ? (trig.intervalMin || 5) : null })} /> 定时触发（仅存在新消息时），每
          <Input type="number" min="1" step="1" style={{ width: 64 }} value={trig.intervalMin ?? 5} onChange={e => setTrig({ ...trig, intervalMin: e.target.value === '' ? null : Number(e.target.value) })} /> 分钟
        </label>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>任一条件满足即触发；同时满足只处理一次。</div>
      {error && <div className="im-status unknown" style={{ marginTop: 8 }}>⚠ {error}</div>}
    </div>
  )
}

function RouteForm({ state, editing, onDone, toast }) {
  const connected = state.accounts.filter(a => a.connected && a.authState !== 'expired')
  const [accountId, setAccountId] = React.useState(editing ? editing.accountId : (connected[0] && connected[0].id) || '')
  const [type, setType] = React.useState(editing ? editing.type : 'group')
  const [scope, setScope] = React.useState(editing ? editing.scope : 'specific')
  const [targets, setTargets] = React.useState(editing ? editing.targets.join(', ') : '')
  const [trig, setTrig] = React.useState(editing && editing.triggers ? { ...editing.triggers } : { mention: true, everyN: null, intervalMin: null })
  const [trigError, setTrigError] = React.useState(null)
  const [conflict, setConflict] = React.useState(null)

  const save = rebindConfirmed => {
    const list = scope === 'specific' ? targets.split(/[,，]/).map(s => s.trim()).filter(Boolean) : []
    if (scope === 'specific' && list.length === 0) return
    let triggers = null
    if (type === 'group') {
      const { mention, everyN, intervalMin } = trig
      if (!mention && everyN == null && intervalMin == null) { setTrigError('至少选择一种触发方式。'); return }
      if (everyN != null && (!Number.isInteger(everyN) || everyN < 1)) { setTrigError('条数需为正整数（N=1 表示每条新消息）。'); return }
      if (intervalMin != null && (!Number.isInteger(intervalMin) || intervalMin < 1)) { setTrigError('间隔需为正整数分钟。'); return }
      triggers = { mention, everyN: everyN ?? null, intervalMin: intervalMin ?? null }
    }
    if (!rebindConfirmed) {
      const hit = list.find(t => CONFLICT_MAP[t])
      if (hit) { setConflict(hit); return }
    }
    onDone({ accountId, type, scope, targets: list, triggers }, editing)
    toast(editing ? '规则已保存' : '规则已添加，默认未启用；可先模拟验证')
  }

  return (
    <div className="rule-form">
      {connected.length === 0 && <Banner kind="warn" style={{ margin: 0, maxWidth: 'none' }}>没有已连接的账号。请先到「设置 → IM 账号」连接账号。</Banner>}
      <div style={{ display: 'flex', gap: 10 }}>
        <select className="input" style={{ flex: 1 }} value={accountId} onChange={e => setAccountId(e.target.value)}>
          {connected.map(a => <option key={a.id} value={a.id}>{PLATFORMS[a.platform].name} · {a.name}</option>)}
        </select>
        <select className="input" style={{ width: 120 }} value={type} onChange={e => setType(e.target.value)}>
          <option value="group">群聊</option>
          <option value="dm">单聊</option>
        </select>
      </div>
      <div className="radio-row">
        <label><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> 全部 <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>（含未来新增会话）</span></label>
        <label><input type="radio" checked={scope === 'specific'} onChange={() => setScope('specific')} /> 指定</label>
      </div>
      {scope === 'specific' && (
        <Input placeholder="会话名称，多个用逗号分隔。试试「DSH 用户反馈群」演示改绑冲突" value={targets} onChange={e => setTargets(e.target.value)} />
      )}
      {type === 'group' && <TriggerBlock trig={trig} setTrig={setTrig} error={trigError} />}
      {conflict && (
        <ConfirmStrip confirmText="确认改绑" onCancel={() => setConflict(null)} onConfirm={() => { setConflict(null); save(true) }}>
          <b>「{conflict}」当前绑定到工作区「{CONFLICT_MAP[conflict]}」。</b><br />
          确认改绑后，新消息由本工作区（deepseek-harness）处理；该会话中正在运行的任务保持原工作区归属直到结束。不会静默覆盖，也不会出现两个工作区同时接管。
        </ConfirmStrip>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="outline" onClick={() => onDone(null)}>取消</Button>
        <Button variant="primary" onClick={() => save(false)}>{editing ? '保存' : '添加（默认不启用）'}</Button>
      </div>
      <div className="hint">新规则默认不启用；可先模拟验证，再打开启用。</div>
    </div>
  )
}

function trigText(r) {
  if (r.type !== 'group' || !r.triggers) return null
  return '触发：' + [r.triggers.mention ? '@' : null, r.triggers.everyN ? `每${r.triggers.everyN}条` : null, r.triggers.intervalMin ? `每${r.triggers.intervalMin}分钟` : null].filter(Boolean).join(' · ')
}

function ImRoutes({ state, set, toast }) {
  const [formMode, setFormMode] = React.useState(null) // null | 'add' | rule
  const [confirmDel, setConfirmDel] = React.useState(null)
  const setRoutes = fn => set(s => ({ ...s, routes: fn(s.routes) }))
  const toggleRoute = (id, on) => {
    setRoutes(list => list.map(r => r.id === id ? { ...r, enabled: on } : r))
    const r = state.routes.find(x => x.id === id)
    toast(on ? '规则已启用：此后新消息由本工作区处理' : (r.scope === 'specific' ? '已停用：保留绑定，不回退到「全部」规则' : '规则已停用'))
  }
  const onDone = (data, editing) => {
    if (data) {
      if (editing) setRoutes(list => list.map(r => r.id === editing.id ? { ...r, ...data } : r))
      else setRoutes(list => [...list, { id: 'r' + Date.now(), enabled: false, ...data }])
    }
    setFormMode(null)
  }

  if (formMode) {
    return (
      <div>
        <button className="ws-back" onClick={() => setFormMode(null)}>← 返回规则列表</button>
        <div className="ws-sec-title">{formMode === 'add' ? '添加规则' : '编辑规则'}</div>
        <RouteForm state={state} editing={formMode === 'add' ? null : formMode} onDone={onDone} toast={toast} />
      </div>
    )
  }
  return (
    <div>
      <div className="ws-sec-title">IM 接管</div>
      <div className="ws-sec-desc">命中规则的会话，新消息由本工作区的 Agent 配置处理。绑定 ≠ 启用。</div>
      <div id="routeList">
        {state.routes.length === 0 && (
          <div className="empty-block" style={{ maxWidth: 'none' }}>
            <div className="t">尚未配置 IM 接管规则</div>
            <div style={{ marginBottom: 14 }}>未命中规则的群或私聊进入「待配置」，不触发 Agent。</div>
          </div>
        )}
        {state.routes.map(r => {
          const { account, pf } = pfOf(state, r.accountId)
          if (!account) return null
          const off = !r.enabled
          const subBase = r.scope === 'all' ? '覆盖当前及未来新会话' : r.targets.join('、')
          const trig = trigText(r)
          return (
            <div key={r.id} className={`rule-row${off ? ' off' : ''}`} data-route={r.id}>
              <PlatformIcon pf={pf} mini />
              <div className="rule-main"><div>
                <div className="rule-name">{account.name} · {r.type === 'group' ? '群聊' : '单聊'}{' '}
                  {r.scope === 'all' ? <span className="scope-pill">全部{r.type === 'group' ? '群聊' : '单聊'}</span>
                    : <><span className="scope-pill">指定 {r.targets.length} 个</span><Pill kind="blue">指定优先</Pill></>}
                  {off && r.scope === 'specific' && <Pill kind="gray">已停用 · 保留绑定</Pill>}
                </div>
                <div className="rule-sub">{subBase}{trig ? ' · ' + trig : ''}</div>
                {off && r.scope === 'specific' && <div className="rule-sub">停用后不回退到「全部」规则；删除绑定才会重新被覆盖</div>}
                {confirmDel === r.id && (
                  <div style={{ marginTop: 8 }}>
                    <ConfirmStrip danger confirmText="确认删除" onCancel={() => setConfirmDel(null)} onConfirm={() => { setRoutes(list => list.filter(x => x.id !== r.id)); setConfirmDel(null); toast('绑定已删除') }}>
                      确认删除该绑定？{r.scope === 'specific' ? '删除后这些会话将重新命中「全部」规则（如有）；保留「停用」才会排除自动处理。' : '删除后该类会话进入「待配置」，不触发 Agent。'}
                    </ConfirmStrip>
                  </div>
                )}
              </div></div>
              <div className="rule-acts">
                <button className="icon-btn" title="编辑" aria-label="编辑规则" onClick={() => setFormMode(r)}><IconEditOutline16 size={14} /></button>
                <button className="icon-btn" title="删除" aria-label="删除规则" onClick={() => setConfirmDel(r.id)}><IconTrashOutline16 size={14} /></button>
                <span className="sw-wrap">启用<Switch checked={r.enabled} label="启用规则" onChange={on => toggleRoute(r.id, on)} /></span>
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ marginTop: 12 }}><Button variant="outline" icon={<IconPlusOutline16 size={14} />} onClick={() => setFormMode('add')}>添加规则</Button></div>
    </div>
  )
}

function simTargetDir(state) {
  const dir = [
    { key: 'qn-all-dm', accountId: 'acc-q1', platform: 'qianniu', label: '千牛 · 潮流女装旗舰店 · 全部单聊', owner: 'merchant-cs', realEnabled: true, external: true },
    { key: 'qn-store2-all-dm', accountId: null, platform: 'qianniu', label: '千牛 · 山货特产直营店 · 全部单聊', owner: 'merchant-cs', realEnabled: true, external: true, identityMissing: true },
  ]
  for (const r of state.routes) {
    const a = state.accounts.find(x => x.id === r.accountId); if (!a) continue
    const pf = PLATFORMS[a.platform]
    if (r.scope === 'all') dir.push({ key: 'local-' + r.id, accountId: a.id, platform: a.platform, label: `${pf.name} · ${a.name} · 全部${r.type === 'group' ? '群聊' : '单聊'}`, owner: 'deepseek-harness（本工作区）', realEnabled: r.enabled })
    else for (const t of r.targets) dir.push({ key: `local-${r.id}-${t}`, accountId: a.id, platform: a.platform, label: `${pf.name} · ${a.name} · ${t}`, owner: 'deepseek-harness（本工作区）', realEnabled: r.enabled })
  }
  return dir
}
function targetState(state, t) {
  if (t.identityMissing) return { ok: false, tag: <Pill kind="red">不可用 · 缺少身份资料</Pill> }
  const a = state.accounts.find(x => x.id === t.accountId)
  if (!a) return { ok: false, tag: <Pill kind="red">不可用 · 缺少身份资料</Pill> }
  const tags = []
  if (!a.connected) tags.push(<Pill key="c" kind="gray">真实：未连接</Pill>)
  else if (a.authState === 'expired') tags.push(<Pill key="e" kind="gray">真实：授权过期</Pill>)
  if (!t.realEnabled) tags.push(<Pill key="d" kind="yellow">真实处理已停用</Pill>)
  tags.push(<Pill key="ok" kind="green">可模拟</Pill>)
  return { ok: true, tag: tags }
}

function ImSim({ state, set, toast }) {
  const [view, setView] = React.useState('summary')
  const [sel, setSel] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [confirmClear, setConfirmClear] = React.useState(false)
  const dir = simTargetDir(state)
  const cur = state.simConfig ? dir.find(t => t.key === state.simConfig.targetKey) : null

  if (view === 'picker') {
    const q = query.trim().toLowerCase()
    const match = dir.filter(t => !q || t.label.toLowerCase().includes(q) || t.owner.toLowerCase().includes(q))
    const groups = [['本工作区（deepseek-harness）', match.filter(t => !t.external)], ['其他工作区', match.filter(t => t.external)]]
    return (
      <div>
        <button className="ws-back" onClick={() => setView('summary')}>← 返回</button>
        <div className="ws-sec-title" style={{ marginBottom: 10 }}>选择测试目标</div>
        <Input placeholder="搜索目标或归属工作区…" value={query} onChange={e => setQuery(e.target.value)} />
        {groups.map(([g, rows]) => rows.length > 0 && (
          <div key={g}>
            <div className="picker-group">{g}</div>
            {rows.map(t => {
              const st = targetState(state, t); const pf = PLATFORMS[t.platform]
              return (
                <button key={t.key} className={`picker-row${sel === t.key ? ' on' : ''}`} disabled={!st.ok} onClick={() => setSel(t.key)}>
                  <PlatformIcon pf={pf} mini />
                  <span style={{ flex: 1, minWidth: 0 }}>{t.label}<div className="sub">归属：{t.owner}</div></span>
                  <span style={{ display: 'flex', gap: 4, flex: 'none' }}>{st.tag}</span>
                </button>
              )
            })}
          </div>
        ))}
        {match.length === 0 && <div className="hint" style={{ padding: '16px 4px' }}>没有匹配的目标。未配置接管路由的会话不会出现在这里。</div>}
        <div className="picker-actions">
          <Button variant="outline" onClick={() => setView('summary')}>取消</Button>
          <Button variant="primary" disabled={!sel} onClick={() => {
            set(s => ({ ...s, simConfig: { targetKey: sel } }))
            setView('summary')
            toast('已保存：仅影响新建模拟，现有实例不变')
          }}>保存目标</Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="ws-sec-title">IM 通道模拟</div>
      <div className="ws-sec-desc">选择一个已配置的 IM 接管目标作为测试目标；本工作区的 Agent 由此获得创建模拟的能力。</div>
      {!cur ? (
        <div className="empty-block" style={{ maxWidth: 640, padding: '26px 16px' }}>
          <div className="t">未配置测试目标</div>
          <div style={{ margin: '6px 0 14px' }}>配置后，本工作区的 Agent 才能创建模拟；未配置则没有模拟能力。</div>
          <Button variant="primary" onClick={() => { setSel(state.simConfig ? state.simConfig.targetKey : null); setView('picker') }}>选择测试目标</Button>
        </div>
      ) : (
        <>
          <div className="sim-target-card">
            <PlatformIcon pf={PLATFORMS[cur.platform]} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{cur.label}</div>
              <div className="hint" style={{ marginTop: 3 }}>归属：{cur.owner}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>{targetState(state, cur).tag}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <Button variant="outline" size="sm" onClick={() => { setSel(state.simConfig.targetKey); setView('picker') }}>更换</Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>清除</Button>
            </div>
          </div>
          {confirmClear && (
            <ConfirmStrip confirmText="确认清除" onCancel={() => setConfirmClear(false)} onConfirm={() => {
              set(s => ({ ...s, simConfig: null }))
              setConfirmClear(false)
              toast('已清除：仅影响新建模拟，现有实例不变')
            }}>
              清除仅影响新建模拟；运行中的实例继续按创建时目标运行。
            </ConfirmStrip>
          )}
        </>
      )}
    </div>
  )
}

export function WorkspaceScreen({ state, set, toast }) {
  const [open, setOpen] = React.useState(true)
  const [sec, setSec] = React.useState('im')
  const workspaces = [
    { name: 'data-center' }, { name: 'Travel-Merchant-Agent-Team' },
    { name: 'deepseek-harness', on: true, onClick: () => setOpen(true) },
  ]
  return (
    <div className="app">
      <LeftNav workspaces={workspaces} />
      <div className="main">
        <div className="hero">
          <h1>探索未至之境 <span className="preview-pill">预览版</span></h1>
          <div className="composer"><div className="ph">描述你想要构建的内容</div></div>
        </div>
        <WorkspaceSettingsModal open={open} onClose={() => setOpen(false)} sec={sec} onSec={setSec}
          title="deepseek-harness" path="/Users/example/IdeaProjects/deepseek-harness（示例路径）">
          {sec === 'general' && (
            <div>
              <div className="ws-sec-title">常规</div>
              <div className="ws-sec-desc">工作区基础信息。</div>
              <div className="card"><div className="card-title">代码仓库</div>
                <div className="info-row"><span className="info-label">Git 远程</span><code className="info-code">github.com/example/deepseek-harness.git（示例）</code></div>
              </div>
            </div>
          )}
          {sec === 'collab' && (
            <div>
              <div className="ws-sec-title">协作</div>
              <div className="ws-sec-desc">把此工作区绑定到云项目，启用成员协作。</div>
              <div className="card"><div className="card-title">云项目</div><Button variant="primary" disabled>创建云项目</Button></div>
            </div>
          )}
          {sec === 'im' && <ImRoutes state={state} set={set} toast={toast} />}
          {sec === 'sim' && <ImSim state={state} set={set} toast={toast} />}
        </WorkspaceSettingsModal>
      </div>
    </div>
  )
}
