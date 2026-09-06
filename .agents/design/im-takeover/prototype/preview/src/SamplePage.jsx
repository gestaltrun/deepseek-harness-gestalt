import React from 'react'
import { Button, Input, Modal, StateDot, Pill, Menu, Tooltip, IconSettingsOutline16, IconSendOutline16, IconPlusOutline16, IconCheckOutline16, IconSearchOutline16, IconCloseOutline16 } from '../../system/components/primitives.js'

/** 正式组件小样页：直接从 dsh-client-ui-primitives 导入的组件清单。 */
export function SamplePage({ onBack }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="sample-page">
      <div className="sample-head">
        <h1>正式组件小样</h1>
        <Button variant="outline" size="sm" onClick={onBack}>← 返回 IM 体验</Button>
      </div>
      <div className="section-desc">全部组件来自 @deepseek-ai/dsh-client-ui-primitives（应用 checkout 0.1.1-rc.2，file: 只读引用）。</div>
      <div className="sample-card">
        <div className="sample-title">Button</div>
        <div className="row">
          <Button variant="primary" icon={<IconSendOutline16 size={16} />}>主按钮</Button>
          <Button variant="primary" disabled>禁用</Button>
          <Button variant="outline">次按钮</Button>
          <Button variant="outline" size="sm">小号</Button>
          <Button variant="ghost" size="sm" icon={<IconPlusOutline16 size={16} />}>幽灵</Button>
        </div>
      </div>
      <div className="sample-card">
        <div className="sample-title">Input</div>
        <div className="row">
          <Input placeholder="正式 Input（带图标）" icon={<IconSearchOutline16 size={16} />} />
          <Input placeholder="普通输入" />
        </div>
      </div>
      <div className="sample-card">
        <div className="sample-title">StateDot / Pill / Tooltip</div>
        <div className="row">
          <StateDot state="done" /><StateDot state="running" /><StateDot state="failed" />
          <Tooltip content="正式 Tooltip"><Button variant="ghost" size="sm">悬停我</Button></Tooltip>
        </div>
      </div>
      <div className="sample-card">
        <div className="sample-title">Modal</div>
        <div className="row"><Button variant="primary" onClick={() => setOpen(true)}>打开正式 Modal</Button></div>
      </div>
      <div className="sample-card">
        <div className="sample-title">图标（正式导出）</div>
        <div className="row" style={{ gap: 14 }}>
          <IconSettingsOutline16 size={20} /><IconSendOutline16 size={20} /><IconPlusOutline16 size={20} />
          <IconCheckOutline16 size={20} /><IconSearchOutline16 size={20} /><IconCloseOutline16 size={20} />
        </div>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="正式 Modal" footer={<Button variant="primary" onClick={() => setOpen(false)}>确认</Button>}>
        <p>来自 dsh-client-ui-primitives 的 Modal：createPortal + useOverlayLock + Esc 关闭。</p>
      </Modal>
    </div>
  )
}
