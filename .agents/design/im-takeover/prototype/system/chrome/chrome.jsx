import React from 'react'
import { Button } from '../components/primitives.js'
import { IconCloseOutline16, IconPlusOutline16, IconFolderOpen16, IconGearOutline16, IconChatOutline16, IconFlaskOutline16, IconUserOutline16, IconPuzzleOutline16, IconPhoneOutline16, IconCardOutline16, IconCollapseOutline16, IconSearchOutline16, IconListPenOutline16 } from './icons.js'
import { Switch } from '../components/ui.jsx'

/** 外层评审工具栏（可收起）：统一示例数据说明 + 故障/数据注入 */
export function ProtoBar({ view, setView, injections, onReset, children }) {
  const [collapsed, setCollapsed] = React.useState(false)
  if (collapsed) return (
    <div className="proto-bar collapsed">
      <button className="proto-reset" onClick={() => setCollapsed(false)}>评审控制</button>
    </div>
  )
  return (
    <div className="proto-bar">
      <span className="proto-tag">设计草稿</span>
      <nav>
        <a className={view === 'im' ? 'on' : ''} onClick={() => setView('im')}>IM 体验</a>
        <a className={view === 'sample' ? 'on' : ''} onClick={() => setView('sample')}>组件小样</a>
        <a className={view === 'baseline' ? 'on' : ''} onClick={() => setView('baseline')}>基线对照</a>
      </nav>
      {children}
      <button className="proto-reset" onClick={onReset}>↺ 重置 demo</button>
      <button className="proto-reset" onClick={() => setCollapsed(true)}>收起</button>
      <span className="proto-note">示例数据 · 仅内存 · 无真实 IM/认证</span>
    </div>
  )
}

export const InjectButton = ({ active, onClick, title, children }) => (
  <button className="proto-reset" style={active ? { background: 'rgba(255,184,77,0.25)' } : undefined} onClick={onClick} title={title}>{children}</button>
)

/** 左侧主导航（工作区 + 会话列表；chrome 为有据重建） */
export function LeftNav({ workspaces, sessions, activeId, onSelect, header }) {
  return (
    <div className="nav">
      <div className="nav-head">
        <div className="brand">deepseek <span className="badge">GESTALT</span></div>
        <button className="icon-btn" aria-label="收起侧边栏"><IconCollapseOutline16 size={16} /></button>
      </div>
      <button className="new-session-btn"><IconPlusOutline16 size={14} />新会话</button>
      {header || (
        <div className="nav-section">工作区
          <span className="acts">
            <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label="搜索会话"><IconSearchOutline16 size={14} /></button>
            <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label="视图选项"><IconListPenOutline16 size={14} /></button>
            <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label="添加工作区"><IconPlusOutline16 size={14} /></button>
          </span>
        </div>
      )}
      {workspaces.map(w => (
        <button key={w.name} className={`ws-row${w.on ? ' on' : ''}`} onClick={w.onClick}><IconFolderOpen16 size={16} />{w.name}</button>
      ))}
      {sessions && <div className="sess-list">
        {sessions.map(s => (
          <button key={s.id} className={`sess-row${activeId === s.id ? ' on' : ''}`} onClick={() => onSelect(s.id)}>
            <span className="t">{s.tag}{s.title}</span><span className="time">{s.time}</span>
          </button>
        ))}
      </div>}
      <div className="nav-foot"><button className="ws-row"><IconGearOutline16 size={16} />设置</button></div>
    </div>
  )
}

const SETTINGS_NAV = [
  ['gear', '通用设置'], ['grid', '模型'], ['puzzle', '插件'], ['sparkle', 'Agent 预设'],
  ['globe', '浏览器'], ['phone', '手机配对'], ['user', '账号池'], ['chat', 'IM 账号'], ['card', '侧边卡片'],
]
const SETTINGS_ICONS = { gear: IconGearOutline16, grid: IconPuzzleOutline16, puzzle: IconPuzzleOutline16, sparkle: IconCardOutline16, globe: IconCardOutline16, phone: IconPhoneOutline16, user: IconUserOutline16, chat: IconChatOutline16, card: IconCardOutline16 }

/** 设置页壳（左 nav + 内容区；有据重建） */
export function SettingsShell({ activeId, onSelect, actions, children }) {
  return (
    <div className="settings-page">
      <div className="settings-nav">
        <div className="settings-title">设置</div>
        {SETTINGS_NAV.map(([icon, label]) => {
          const Ic = SETTINGS_ICONS[icon]
          return <button key={label} className={`snav-item${label === activeId ? ' on' : ''}`} onClick={() => onSelect && onSelect(label)}><Ic size={16} />{label}</button>
        })}
      </div>
      <div className="settings-body">
        <div className="settings-actions">{actions}</div>
        {children}
      </div>
    </div>
  )
}

/** 工作区设置弹层（固定头 + 左导航 + 独立滚动；已确认功能增量，不属正式基线） */
export function WorkspaceSettingsModal({ open, onClose, sec, onSec, title, path, children }) {
  if (!open) return null
  const SECS = [['general', '常规', IconGearOutline16], ['collab', '协作', IconUserOutline16], ['im', 'IM 接管', IconChatOutline16], ['sim', 'IM 模拟', IconFlaskOutline16]]
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label="工作区设置">
        <div className="ws-head">
          <div>
            <div className="modal-title">工作区设置 · {title}</div>
            <div className="modal-path">{path}</div>
          </div>
          <button className="modal-close" aria-label="关闭工作区设置" onClick={onClose}><IconCloseOutline16 size={20} /></button>
        </div>
        <div className="ws-body">
          <nav className="ws-nav" aria-label="工作区设置导航">
            {SECS.map(([id, label, Ic]) => <button key={id} className={sec === id ? 'on' : ''} onClick={() => onSec(id)}><Ic size={14} />{label}</button>)}
          </nav>
          <div className="ws-content" id="wsContent">{children}</div>
        </div>
      </div>
    </div>
  )
}

/** 右侧 Sidebar 壳（tab strip + 内容；有据重建） */
export function SidebarShell({ tabs, tools, children }) {
  return (
    <div className="sidebar">
      <div className="sb-tabstrip">
        {tabs.map(t => (
          <button key={t.label} className={`sb-tab${t.on ? ' on' : ''}`}>
            {t.icon}{t.label}{t.badge && <span className="badge-n">{t.badge}</span>}
            {t.on && <span className="x" aria-label="关闭标签"><IconCloseOutline16 size={12} /></span>}
          </button>
        ))}
        <div className="sb-tools">
          <button className="icon-btn" aria-label="新建标签页"><IconPlusOutline16 size={14} /></button>
          <button className="icon-btn" aria-label="折叠侧边栏"><IconCollapseOutline16 size={14} /></button>
        </div>
      </div>
      <div className="sb-body">{children}</div>
    </div>
  )
}
