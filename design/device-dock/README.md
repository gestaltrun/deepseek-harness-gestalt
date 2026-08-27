# 手机设备 dock · 静态高保真设计稿

Throwaway hi-fi mockups for the `ui-device-dock` first-party plugin（设置启用 → 环境探测 → 右栏实时画面）。
每页都是**独立可直接双击打开**的 HTML：内联 CSS + 少量原生 JS，无 React、无外部 CDN、零网络请求；
颜色全部来自内联的 `--dsw-*` token sheet（提取自 `packages/client/ui-theme/src/styles/`，
暗色重映射挂在与生产一致的 `[data-ds-dark-theme]` 同名属性上，本稿写作 `[data-dsw-dark-theme]` 以便子树演示）。
production 不 import 本目录任何文件。

## 页面索引

| 文件 | 一句话说明 |
|---|---|
| [settings-card.html](./settings-card.html) | Plugins 设置分区「手机设备」卡片状态机六态纵排：默认关闭 → 探测环境（adb / mobilecli / AVD / Xcode runtime 检查项）→ Android 向导（sdkmanager 建卡复制命令）→ iOS 向导（runtime 下载 + simctl + WDA 前置）→ 就绪设备清单（模拟器 / 模拟器(iOS) / USB 真机 三组）→ 三种错误行样例。 |
| [device-dock.html](./device-dock.html) | ≥1440px 三列布局右侧 page-owned 设备 dock 主视图：19.5:9 SVG 假画面、无框/边框/真机壳三档切换、Back·Home·Recents·旋转·截图·刷新工具条（中文 tooltip）、分组设备下拉、MJPEG 10fps / H264 30fps 两档徽标、左缘拖拽调宽（max 960，双击复位）、会话列 <640px 提示；下方附横屏加宽变体静态块。 |
| [dock-overlay-narrow.html](./dock-overlay-narrow.html) | <1100px 时 dock 转居中 overlay 的变体：bg-mask-3 遮罩 + 居中面板 + 关闭按钮（×/Esc/点遮罩），关闭后以「打开设备面板」浮标与会话内胶囊恢复。 |
| [conversation-integration.html](./conversation-integration.html) | 会话内集成：`device_open`（含 auto-open 提示）/ `device_observe` / `device_act tap(0.5,0.32)` 三张一线高紧凑工具卡（仅标题、设备名、状态徽标、「打开侧栏」线索，无内嵌图），composer 上方绿色圆点「Pixel_6_API_35 · 实时」状态胶囊；可勾选显示槽位标注。 |
| [dark-light.html](./dark-light.html) | device dock 一屏的亮 / 暗双栏对照：两栏标记与样式完全一致，仅外层切换主题属性，下方附各栏别名取色卡，证明 token 映射成立。 |

## Slot / 交互假设速查

- 设置卡随插件启停，占 `settings.plugin.item` keyed namespace 卡片；关闭时 Host 不注册 `device_*` 工具。
- 设备画面只在右侧 page-owned dock；左缘拖拽条对应 ui-layout details 浮标边界契约（960 上限、640 Session 最小宽、concession 转右缘 overlay）。
- 窄视口兜底注册 `shell.overlay`（list），遮罩用 `bg-mask-3`。
- 工具卡走通用 tool call 行（presentation generic）；流状态胶囊占 `conversation.input.dock`（composer 上方独占一行）。

## 已知取舍

- 「已停止」设备的动作键是「启动」，其「打开面板」呈禁用态——先拉起再开面板。
- 拖拽调宽到挤压会话列时出琥珀提示，展示真实布局的 concession 行为而不只是静默压缩。
- 亮暗派生 tint（红/蓝 12% 背景、机身边缘高光）无对应别名，已在 CSS 内注释派生来源。
