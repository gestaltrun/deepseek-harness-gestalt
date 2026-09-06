import React from 'react'
import { Button, IconCheckOutline14, IconAlertOutline16, IconWrenchOutline16, IconImageOutline16 } from './primitives.js'

export const Switch = ({ checked, disabled, onChange, label }) => (
  <span className="switch">
    <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.checked)} />
    <span className="track" />
  </span>
)

export const Pill = ({ kind = 'gray', dot, children }) => (
  <span className={`pill pill-${kind}`}>{dot && <span className="dot" />}{children}</span>
)

export const Banner = ({ kind = 'info', children, style }) => (
  <div className={`banner banner-${kind}`} style={style}>
    <IconAlertOutline16 size={16} /><span>{children}</span>
  </div>
)

export const ConfirmStrip = ({ danger, children, onCancel, onConfirm, confirmText = '确认' }) => (
  <div className={`confirm-strip${danger ? ' danger' : ''}`}>
    {children}
    <div className="acts">
      <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
      <Button variant="primary" size="sm" onClick={onConfirm}>{confirmText}</Button>
    </div>
  </div>
)

export const Spinner = () => <span className="spin" />

export const PlatformIcon = ({ pf, mini }) => (
  <span className={`${mini ? 'mini-platform' : 'platform-ic'} ${pf.cls}`}>{pf.letter}</span>
)

export const ToolCall = ({ name, tag, body, result }) => (
  <div className="tool-call">
    <div className="tc-head"><IconWrenchOutline16 size={14} />Tool call · <code>{name}</code>{tag && <Pill kind="sim">{tag}</Pill>}</div>
    <div className="tc-body">{body}</div>
    {result && <div className="tc-result"><IconCheckOutline14 size={14} />{result}</div>}
  </div>
)

/** IM 消息行：身份五分类 + 引用 + 图片 + 不支持类型明细 */
export function ImRow({ m }) {
  const [open, setOpen] = React.useState(false)
  if (m.kind === 'unsupported') return (
    <div className="im-row in">
      <div className="im-avatar">{m.who[0]}</div>
      <div className="im-col">
        <div className="im-who">{m.who} <span className="id-tag id-ext">{m.tagText}</span> {m.time}</div>
        <div className="im-unsupported">[不支持的消息类型：{m.mtype}]
          <button onClick={() => setOpen(!open)}>查看明细</button>
          {open && <div className="detail">{m.detail}</div>}
        </div>
      </div>
    </div>
  )
  if (m.kind === 'image') return (
    <div className="im-row in">
      <div className="im-avatar">{m.who[0]}</div>
      <div className="im-col">
        <div className="im-who">{m.who} <span className="id-tag id-ext">{m.tagText}</span> {m.time}</div>
        <div className="im-bubble" style={{ padding: 4 }}><div className="im-img"><IconImageOutline16 size={20} /></div></div>
      </div>
    </div>
  )
  const avatar = m.tag === 'ai'
    ? <div className="im-avatar" style={{ background: 'var(--dsw-alias-brand-primary)', color: '#fff' }}>AI</div>
    : <div className="im-avatar">{m.who[0]}</div>
  return (
    <div className={`im-row ${m.side}`}>
      {avatar}
      <div className="im-col">
        <div className="im-who">{m.tag === 'ai' ? '' : m.who + ' '}<span className={`id-tag id-${m.tag}`}>{m.tagText}</span> {m.tag === 'ai' ? m.who + ' ' : ''}{m.time}</div>
        <div className="im-bubble">
          {m.quote && <div className="quote-block">{m.quote}</div>}
          <span dangerouslySetInnerHTML={{ __html: m.html }} />
        </div>
        {m.status === 'delivered' && <span className="im-status ok"><IconCheckOutline14 size={12} />已送达</span>}
        {m.status === 'sending' && <span className="im-status sending">● 发送中</span>}
        {m.status === 'unknown' && <span className="im-status unknown"><IconAlertOutline16 size={12} />发送结果待确认 · 未自动重发 <button className="link-btn" style={{ fontSize: '10.5px' }}>重试</button></span>}
      </div>
    </div>
  )
}

/** 底部 toast（demo 操作反馈） */
export function Toast({ toast }) {
  if (!toast) return null
  return <div className="toast on"><IconCheckOutline14 size={14} />{toast}</div>
}
