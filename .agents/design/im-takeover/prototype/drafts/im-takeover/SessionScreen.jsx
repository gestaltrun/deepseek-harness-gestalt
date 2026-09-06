import React from 'react'
import { Button, IconPlusOutline16, IconGoalOutline16, IconSendOutline14, IconStopFill16, IconFolderOpen16, IconNewChatOutline16, IconCodeOutline16, IconCollapseOutline16, IconSearchOutline16, IconGearOutline16 } from '../../system/components/primitives.js'
import { Pill, ToolCall, ImRow, Spinner, PlatformIcon, ConfirmStrip } from '../../system/components/ui.jsx'
import { SidebarShell } from '../../system/chrome/chrome.jsx'
import { SESSIONS, REAL_MSGS_SEED, PLATFORMS } from '../../fixtures/imData.js'

function SessionMain({ sd, role }) {
  const isSim = !!sd.sim
  const headTitle = !isSim ? sd.head.title : role === 'simuser' ? `${sd.navTitle.replace('模拟：', '')} · 模拟用户 Agent` : `${sd.buyerLabel} 接待 · 被测 Agent`
  const headSub = !isSim ? sd.head.sub : '/ ' + (role === 'simuser' ? sd.simUserWs + '（模拟用户 Agent 自己的工作区）' : sd.testedWs + '（目标绑定的被测工作区）')
  return (
    <div className="session-main">
      <div className="session-head">{headTitle} <span className="sub">{headSub}</span></div>
      <div className="conv-tabs"><button className="conv-tab on">对话</button><button className="conv-tab">轨迹</button></div>
      <div className="msg-flow">
        {!isSim && (
          <>
            <div className="msg-user">看下「度假开发联调群」里大家在讨论什么，需要处理的帮我跟进</div>
            <div className="msg-ai"><p>已读取群消息。群里在讨论周末发布的回滚方案，@张伟 提了一个支付回调偶发超时的问题，我已经在后台开始排查。</p><p>右侧「IM 对话」面板可以对照查看群里的原始消息流。</p></div>
            <ToolCall name="bash" body={'pnpm --filter pay-gateway test -- callback-retry'} result="24 passed（示例输出）" />
          </>
        )}
        {isSim && sd.unconfigured && (
          <div className="empty-block" style={{ maxWidth: 560, textAlign: 'left', padding: 24 }}>
            <div className="t">当前工作区未配置「IM 通道模拟」</div>
            <div style={{ margin: '8px 0 14px', lineHeight: 1.7 }}>模拟用户 Agent <b>没有</b>创建模拟 / 指定身份发送 / 结束等模拟工具。需要在其所属工作区（{sd.simUserWs}）的「工作区设置 → IM 通道模拟」中选择一个已配置的接管目标。</div>
          </div>
        )}
        {isSim && !sd.unconfigured && role === 'simuser' && (
          <>
            <div className="msg-user">{sd.simUserAsk}</div>
            <ToolCall name="im_sim.create" tag="模拟通道（示意）"
              body={`target: 千牛 · ${sd.target} · 单聊（命中「全部单聊」规则）\nas: ${sd.buyer}（模拟买家）${sd.history ? `\nhistory: ${sd.history.file}（${sd.history.count} 条，仅可查询背景）` : ''}`}
              result={`模拟实例 ${sd.instance} 已创建（仅走模拟通道，不触达真实 IM）`} />
            <ToolCall name="im_sim.send" tag="模拟通道（示意）"
              body={`instance: ${sd.instance}\nas: ${sd.buyer}\ntext: "${sd.msgs[0].html.replace(/<[^>]+>/g, '')}"`}
              result="已投递给被测 Agent；回信将由系统自动送回本会话，无需监听" />
            <div className="msg-ai"><p>买家提问已发出。点右侧「被测 Agent Session」可查看同一实例的被测视角；收到回复后我会继续扮演买家追问。</p></div>
          </>
        )}
        {isSim && !sd.unconfigured && role === 'tested' && (
          <>
            <div className="inbound-env">
              <div className="ie-head">IM 入站消息 · 千牛 · {sd.buyer} · 刚刚</div>
              {sd.msgs[0].html.replace(/<[^>]+>/g, '')}
              <div className="ie-note">被测 Agent 收到的格式与真实 IM 一致；看不到模拟侧的内部信息</div>
            </div>
            <div className="msg-ai"><p>您好，有的。会员可领 10 元券，需要帮您查库存吗？</p></div>
            <ToolCall name="im.send"
              body={`to: ${sd.buyerLabel}\ntext: "您好，有的。会员可领 10 元券，需要帮您查库存吗？"`}
              result={`已投递：回到模拟实例 ${sd.instance}，不触达真实买家`} />
          </>
        )}
      </div>
      <div className="composer-dock">
        <div className="composer" style={{ width: '100%' }}>
          <div className="ph">给智能体发消息</div>
          <div className="composer-bar">
            <button className="icon-btn" aria-label="添加"><IconPlusOutline16 size={16} /></button>
            <button className="dropdown-pill"><IconGoalOutline16 size={14} /><b>Workspace Write</b></button>
            <span className="spacer" />
            <button className="dropdown-pill">{sd.modelChip}</button>
            <button className="send-btn" aria-label="发送"><IconSendOutline14 size={14} /></button>
          </div>
        </div>
      </div>
      <div className="status-bar">{sd.statusBar.map(x => <span key={x}>{x}</span>)}</div>
    </div>
  )
}

function RealSidebar({ msgs, setMsgs, strip, setStrip, toast }) {
  const [input, setInput] = React.useState('')
  const flowRef = React.useRef(null)
  React.useEffect(() => { if (flowRef.current) flowRef.current.scrollTop = flowRef.current.scrollHeight }, [msgs, strip])
  const strips = {
    live: <div className="takeover-strip green"><span className="dot-g" />AI 接待中 · 入站消息由本工作区配置处理<span className="spacer" /><button className="link-btn" onClick={() => setStrip('disabled')}>停用自动处理</button></div>,
    unknown: <div className="takeover-strip green"><span className="dot-g" />AI 接待中<span className="spacer" /></div>,
    disabled: <div className="takeover-strip gray"><span className="dot-gray" />自动处理已停用 · 仅记录消息，不触发 Agent；你仍可手动发送<span className="spacer" /><button className="link-btn" onClick={() => setStrip('live')}>启用</button></div>,
    offline: <div className="takeover-strip red">⚠ 账号已断连 · 消息暂停同步，14:02 后的消息将在重连后补拉<span class="spacer" /><button className="link-btn">查看账号</button></div>,
  }
  const shown = strip === 'unknown'
    ? [...msgs, { side: 'out', who: '数字员工', tag: 'ai', tagText: 'AI', time: '09:24', html: '排查结果：22:40 批次超时是网关重试窗口过短导致，建议调整到…', status: 'unknown' }]
    : msgs
  const send = () => {
    const text = input.trim(); if (!text) return
    setMsgs(list => [...list, { side: 'out', who: '陈小宇', tag: 'self-dsh', tagText: '本人 · DSH', time: '现在', html: text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), status: 'delivered' }])
    setInput('')
    toast('已追加到消息流（真实消息不会发送）')
  }
  return (
    <SidebarShell tabs={[
      { label: 'IM 对话 · 度假开发…', on: true, badge: 2, icon: <IconNewChatOutline16 size={14} /> },
      { label: '文件', icon: <IconFolderOpen16 size={14} /> }, { label: '终端', icon: <IconCodeOutline16 size={14} /> },
    ]}>
      <div className="im-head">
        <div className="im-title"><PlatformIcon pf={PLATFORMS.dingtalk} mini /><span className="grp">群聊：度假开发联调群</span></div>
        <div className="im-meta"><Pill kind="gray">账号：陈小宇</Pill><Pill kind="gray">32 人</Pill><button className="ws-link">工作区：deepseek-harness ↗</button></div>
      </div>
      {strips[strip]}
      <div className="im-flow" ref={flowRef}>{shown.map((m, i) => <ImRow key={i} m={m} />)}</div>
      {strip === 'offline' && <div className="cursor-note">断连前已同步到 09:23。重连后向 Agent 提供最新一批消息，过多时明确标注省略，Agent 可用消息查询工具补查；旧历史不会伪装成刚收到的新消息。</div>}
      <div className="im-composer">
        <div className="id-line">以 <b>陈小宇（本人）</b> 身份发送到「度假开发联调群」 · 真实消息不会发送</div>
        <div className="im-input-row">
          <textarea className="im-input" rows="1" placeholder="手动回复（不经过 Agent）…" disabled={strip === 'offline'}
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="send-btn" aria-label="发送" disabled={strip === 'offline'} onClick={send}><IconSendOutline14 size={14} /></button>
        </div>
      </div>
    </SidebarShell>
  )
}

function SimSidebar({ sd, st, role, onRole, onFollowUp, onStop, simConfig }) {
  const [input, setInput] = React.useState('')
  const [confirmStop, setConfirmStop] = React.useState(false)
  const flowRef = React.useRef(null)
  React.useEffect(() => { if (flowRef.current) flowRef.current.scrollTop = flowRef.current.scrollHeight }, [sd.msgs, st])
  if (sd.unconfigured) {
    return (
      <SidebarShell tabs={[{ label: 'IM 对话', on: true, icon: '💬' }]}>
        <div className="im-flow" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="empty-block" style={{ maxWidth: 'none', width: '100%', padding: '28px 16px' }}>
            <div className="t">没有进行中的模拟实例</div>
            <div>未配置「IM 通道模拟」时不会创建实例，也不会出现模拟消息流。</div>
          </div>
        </div>
      </SidebarShell>
    )
  }
  const diverged = !simConfig || simConfig.targetKey !== sd.createdTargetKey
  const stripMap = {
    running: <div className="takeover-strip green"><span className="dot-g" />模拟进行中 · 双向自动投递<span className="spacer" /></div>,
    stopping: <div className="takeover-strip yellow"><Spinner />停止中 · 双向投递已关闭，正在请求停止双方执行与派生任务…<span className="spacer" /></div>,
    stopped: <div className="takeover-strip gray">■ 已停止 · 历史可查看，不再投递；如需继续请新建实例<span className="spacer" /></div>,
  }
  const follow = () => {
    const text = input.trim(); if (!text) return
    onFollowUp(text); setInput('')
  }
  return (
    <SidebarShell tabs={[{ label: `IM 对话 · ${sd.buyer}`, on: true, icon: <IconNewChatOutline16 size={14} /> }, { label: '文件', icon: <IconFolderOpen16 size={14} /> }]}>
      <div className="im-head">
        <div className="im-title"><PlatformIcon pf={PLATFORMS.qianniu} mini /><span className="grp">单聊：{sd.buyerLabel}</span><Pill kind="sim">模拟</Pill></div>
        <div className="im-meta"><Pill kind="gray">目标：{sd.target}</Pill><button className="ws-link">被测工作区：{sd.testedWs} ↗</button></div>
        <div className="sim-banner">
          <span>
            模拟实例 {sd.instance} · 一对一（本模拟用户 Session 只对应此实例）· 消息不投递真实买家<br />
            <b>本实例使用创建时的目标：{sd.createdTargetLabel}（归属 {sd.testedWs}）</b>
            {diverged && <><br />工作区模拟配置已{simConfig ? '变更' : '取消'}：<b>仅影响新建模拟，本实例不变</b>，继续按创建时目标运行直到结束。</>}
          </span>
        </div>
        <div className="peer-links">
          <button className={`peer-link${role === 'tested' ? ' on' : ''}`} onClick={() => onRole('tested')}>⇄ 被测 Agent Session</button>
          <button className={`peer-link${role === 'simuser' ? ' on' : ''}`} onClick={() => onRole('simuser')}>⇄ 模拟用户 Agent Session</button>
        </div>
        {sd.history && <div className="history-note"><IconFolderOpen16 size={14} /> 已加载历史文件 <code>{sd.history.file}</code> · {sd.history.count} 条 · <b>仅可查询背景，不逐条触发</b></div>}
      </div>
      {stripMap[st]}
      <div className="im-flow" ref={flowRef}>{sd.msgs.map((m, i) => <ImRow key={i} m={m} />)}</div>
      <div className="im-composer">
        {st === 'running' && (
          <>
            <div className="im-input-row" style={{ marginBottom: 8 }}>
              <textarea className="im-input" rows="1" placeholder={`以 ${sd.buyer} 身份继续发送…`}
                value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); follow() } }} />
              <button className="send-btn" aria-label="发送" onClick={follow}><IconSendOutline14 size={14} /></button>
            </div>
            <div className="sim-stop-row"><Button variant="outline" size="sm" icon={<IconStopFill16 size={14} />} style={{ flex: 1 }} onClick={() => setConfirmStop(true)}>停止模拟</Button></div>
            {confirmStop && (
              <ConfirmStrip danger confirmText="确认停止" onCancel={() => setConfirmStop(false)} onConfirm={() => { setConfirmStop(false); onStop() }}>
                确认停止模拟实例 {sd.instance}？将关闭双向投递，并请求停止该实例专属的双方执行与派生任务。历史保留、变为只读。
              </ConfirmStrip>
            )}
            <div className="id-line" style={{ marginTop: 8 }}>停止只影响当前实例 {sd.instance}；修改/取消模拟配置不影响本实例的收发与停止</div>
          </>
        )}
        {st === 'stopping' && <div className="id-line">尚未停下的动作如实显示「停止中」，不承诺回滚已发生的副作用</div>}
        {st === 'stopped' && <div className="id-line">首版不支持原实例续跑；可用历史文件作为背景创建新实例</div>}
      </div>
    </SidebarShell>
  )
}

/** 正式结构：常驻图标轨 + 可展开会话面板（工作区/会话列表的既有导航位置）。 */
function FishMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 12c3-4.5 7-6.5 10-6.5 3.5 0 6.5 2.5 8 6.5-1.5 4-4.5 6.5-8 6.5-3 0-7-2-10-6.5z" fill="var(--dsw-static-deepseek-500)" />
      <circle cx="15.5" cy="11" r="1.2" fill="#fff" />
    </svg>
  )
}

function IconRail({ panelOpen, onToggle }) {
  return (
    <div className="icon-rail">
      <div className="rail-logo" aria-hidden="true"><FishMark /></div>
      <button className="icon-btn" aria-label="新会话"><IconPlusOutline16 size={18} /></button>
      <button className={`icon-btn${panelOpen ? ' on' : ''}`} aria-label={panelOpen ? '收起会话面板' : '展开会话面板'} onClick={onToggle}><IconCollapseOutline16 size={18} /></button>
      <button className="icon-btn" aria-label="搜索"><IconSearchOutline16 size={18} /></button>
      <div className="rail-foot">
        <button className="icon-btn" aria-label="设置"><IconGearOutline16 size={18} /></button>
      </div>
    </div>
  )
}

function SessionPanel({ sessions, activeId, onSelect }) {
  return (
    <div className="session-panel">
      <div className="nav-section">deepseek-harness · 会话</div>
      <div className="sess-list">
        {sessions.map(s => (
          <button key={s.id} className={`sess-row${activeId === s.id ? ' on' : ''}`} onClick={() => onSelect(s.id)}>
            <span className="t">{s.tag}{s.title}</span><span className="time">{s.time}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function SessionScreen({ state, set, toast, strip, setStrip }) {
  const [activeId, setActiveId] = React.useState('real')
  const [role, setRole] = React.useState('agent')
  const [panelOpen, setPanelOpen] = React.useState(false)
  const sd = SESSIONS[activeId]
  const sessions = Object.entries(SESSIONS).map(([id, s]) => {
    const st = s.sim && s.instance ? state.sim[s.instance].status : null
    const stopped = st === 'stopped'
    return { id, title: s.navTitle, time: s.time, tag: s.sim ? <span className="pill pill-sim" style={{ fontSize: 10 }}>模拟{stopped ? ' · 已结束' : ''}</span> : null }
  })
  const switchSession = id => { setActiveId(id); setRole(SESSIONS[id].sim ? 'simuser' : 'agent') }
  const setMsgs = fn => set(s => ({ ...s, realPanelMsgs: fn(s.realPanelMsgs || REAL_MSGS_SEED) }))
  const onFollowUp = text => {
    set(s => {
      const msgs = [...sd.msgs,
        { side: 'in', who: sd.buyer, tag: 'ext', tagText: '模拟买家', time: '现在', html: text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) },
        { side: 'out', who: '客服助手', tag: 'ai', tagText: 'AI · 被测', time: '现在', html: '收到，为您核实后回复。', status: 'delivered' }]
      return { ...s, simMsgs: { ...(s.simMsgs || {}), [activeId]: msgs } }
    })
    toast('已在原实例内完成一轮收发（不跨原目标）')
  }
  const onStop = () => {
    set(s => ({ ...s, sim: { ...s.sim, [sd.instance]: { status: 'stopping' } } }))
    setTimeout(() => {
      set(s => ({ ...s, sim: { ...s.sim, [sd.instance]: { status: 'stopped' } } }))
      toast(`模拟实例 ${sd.instance} 已停止（历史只读）`)
    }, 1500)
  }
  const sdView = sd.sim && state.simMsgs && state.simMsgs[activeId] ? { ...sd, msgs: state.simMsgs[activeId] } : sd
  const st = sd.sim && sd.instance ? state.sim[sd.instance].status : null

  return (
    <div className="session-wrap">
      <IconRail panelOpen={panelOpen} onToggle={() => setPanelOpen(!panelOpen)} />
      {panelOpen && <SessionPanel sessions={sessions} activeId={activeId} onSelect={switchSession} />}
      <SessionMain sd={sdView} role={role} />
      {activeId === 'real'
        ? <RealSidebar msgs={state.realPanelMsgs || REAL_MSGS_SEED} setMsgs={setMsgs} strip={strip} setStrip={setStrip} toast={toast} />
        : <SimSidebar sd={sdView} st={st} role={role} onRole={setRole} onFollowUp={onFollowUp} onStop={onStop} simConfig={state.simConfig} />}
    </div>
  )
}
