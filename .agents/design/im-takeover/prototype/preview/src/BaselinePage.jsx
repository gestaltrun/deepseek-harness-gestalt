import React from 'react'
import { Button } from '../../system/components/primitives.js'

/** 基线对照：发布归档不含私人 GUI 参考截图，因此明确显示不可提供状态。 */
export function BaselinePage({ onBack }) {
  return (
    <div className="sample-page">
      <div className="sample-head">
        <h1>基线对照</h1>
        <Button variant="outline" size="sm" onClick={onBack}>← 返回 IM 体验</Button>
      </div>
      <div className="sample-card baseline-unavailable" role="status">
        <div className="sample-title">正式 GUI 基线不可提供</div>
        <p>发布归档故意不包含正式 GUI 参考截图：这些截图可能包含真实会话与个人信息。当前没有可公开的合法参照材料，因此本页不请求图片，也不用演示截图冒充正式基线。</p>
        <p>组件小样仍可验证正式 primitives；完整 GUI 保真验收需要在授权环境中重新采集基线。</p>
      </div>
    </div>
  )
}
