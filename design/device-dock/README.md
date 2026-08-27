# 手机设备接入 · 静态高保真设计稿

Throwaway hi-fi mockups for the `ui-device-dock` 方案。**主稿承载为已存在的多类型侧栏包
`packages/client/ui-better-sidebar`**（VSCode 风格 Tab 条 +「+」菜单）：以外部插件身份
`ctx.get('betterSidebar').registerTab(descriptor)` 新增一类「手机」tab；此前按右栏 page-owned
dock 探索的稿子保留作对照与未来扩展位参考。

每页都是**独立可直接双击打开**的 HTML：内联 CSS + 少量原生 JS，无 React、无外部 CDN、零网络请求；
颜色全部来自内联的 `--dsw-*` token sheet（提取自 `packages/client/ui-theme/src/styles/`）。
production 不 import 本目录任何文件。

## 对焦主稿（A / B）

| 文件 | 一句话说明 |
|---|---|
| [better-sidebar-integration.html](./better-sidebar-integration.html) | **主稿 A · 骨架还原**：ui-better-sidebar 面板像素级还原——34px Tab 条（内置 editor/git/subagent/sidechat/terminal/browser 各项 + 新增「手机」项）、右端「+」菜单展开态把「手机」列为可选类型（含 terminal 满 3 的禁用行示例）；每个元素标注对应源码符号与行号（TabDescriptor 字段 / buildNewTabOptions 排序 / PANEL 几何）。 |
| [phone-tab.html](./phone-tab.html) | **主稿 B · 「手机」tab 内容四态纵排**（全部按面板默认宽 400px 排版，尺寸来源在页头注明）：① 未连接空态（Android/iOS 平台选择 + 模拟器/真机分组清单、状态点、启动按钮）② 启动中（AVD/Xcode runtime 命令级指引卡 + 复制按钮 + 拉起进度行）③ 已连接（react-device-view 形态嵌在面板宽度内：占位渐变画面、紧凑工具条 Back/Home/Recents/截图、触控说明一行、MJPEG 10fps / H264 30fps 徽标、「加宽至右侧」虚按钮示意扩展位）④ 错误两例（adb 未找到 / 真机未授权）。 |

### 尺寸事实来源（两篇主稿共用）

- `src/client/state.ts L121–124` — `PANEL_MIN 280` / `PANEL_MAX 640` / `PANEL_DEFAULT 400` / `TAB_MAX_WIDTH 160`
- `src/client/sidebar.module.css L759/L811/L880/L527/L1595` — Tab 条高 34px、tab 宽 64–160、+ 按钮 22×22、iconButton 28 圆形、browserInput 高 28
- `src/prefs-shared.ts L227–229` — 默认宽度百分比 20–60（默认 35%，1440 视口 ≈ 504，钳入 [280,640]）
- `src/client/state.ts L133–138` — 自由窗口已有 390×780「手机比例」先例
- 注册语义：`builtins/tabs.tsx`（7 类内置描述符与 order）、`Sidebar.tsx L167–179`（buildNewTabOptions 过滤/排序/禁用）、`service.ts L142–244`（TabComponentProps / TabDescriptor）、`BrowserView.tsx`(地址栏+沙箱 iframe 的 tab 长相)、`ui-workbench`（外部包委派样例 workbenchBrowser）

## 对照稿（保留，非主稿）

| 文件 | 一句话说明 |
|---|---|
| [settings-card.html](./settings-card.html) | 插件设置卡六态（默认关闭→探测→双端向导→就绪清单→错误样例）；启用开关语义仍适用于「手机」tab 的功能总闸 |
| [device-dock.html](./device-dock.html) | 右栏 page-owned 设备 dock 桌面稿（三列布局右缘，拖宽上限 960、横屏变体）；作为侧栏加宽 >PANEL_MAX 后的体验承接方保留 |
| [dock-overlay-narrow.html](./dock-overlay-narrow.html) | dock 窄视口居中 overlay 变体（遮罩 + 关闭 + 浮标恢复） |
| [conversation-integration.html](./conversation-integration.html) | 会话内紧凑工具卡 + composer 上方实时胶囊（conversation.input.dock），与「手机」tab 并存的会话侧线索 |
| [dark-light.html](./dark-light.html) | 同一标记亮暗双栏对照，证明 token 映射 |

## 已知取舍

- 「手机」tab 未创建设备时不在「+」菜单禁用入口（对比 terminal 满 3 的禁用行）——空态引导放 tab 内部，保持入口恒可达。
- 多设备并存策略二选一待拍板：`createTab` mint `phone:<serial>` 可并存，或 `single:true` 单例聚焦；A 稿对照表列了两种。
- 右栏 dock 相关稿件降级为「>640px 加宽」的未来承接位；conversation 胶囊仍是面板关闭时的驻留提示。
