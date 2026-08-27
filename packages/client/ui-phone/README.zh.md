# @deepseek-ai/dsh-client-ui-phone

[English](README.md) | 中文

「手机」tab 插件：向 `ctx.betterSidebar` 注册表登记 `phone` tab 类型（id `phone`、标题 手机、单色内联 SVG 图标、`order: 55`、`single: true`）。入口恒可达——`available` 永不拒绝，零设备的部署同样能打开该 tab，落到已锁稿的未连接空态：Android/iOS 平台分段选择、分组设备清单（模拟器 / USB 真机）、USB 占位行与「重新检测环境」控件。tab 内容只实现未连接空态；启动中、已连接与错误三态属于后续 device-dock 子票。

部署级启用闸门挂在插件 `Config` 上：`enabled`（boolean，schemastery 校验，默认 `false`）。注册不依赖它——关闭时入口仍然可达，tab 内容会在空态上方固定渲染「手机连接未启用」说明条。闸门关闭时不发现设备、不拉起 `mobilecli`、不路由任何流；本包当前也不存在这类代码。

条状徽标与内容清单读取同一个注入抽象 `PhoneBadgeSource`（`getBadge(): { onlineCount }` 供每次渲染的徽标读取，`listDevices(platform)` 供清单行读取）。随包默认是空实现 `NULL_PHONE_BADGE_SOURCE`；mobilecli provider 在后续子票替换它。徽标取值：存在在线设备时输出在线台数，否则为 `null`。

组装关系：`tsconfig.client.json` 聚合引用本包；`packages/bundle/web-app/cordis.patch.yml` 携带 `ui-phone` 浏览器行；`packages/bundle/web-app/package.json` 声明依赖。Node 半边是空 apply（纯 UI 插件）；包 invariant 伴生体在同进程 fake 注册表上以真实 cordis fiber 证明注册/注销对称。

## Model Experience

无。本包只注册侧栏 tab 并渲染 HTML；不贡献 prompt 段、工具 schema、流或会话事件，启用闸门也不增加任何模型可见面。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## Known Limitations and Deferred Work

- **徽标保真缺口**——已锁稿的 灰点（无设备）/ 绿色数字（在线台数）需要点形与配色渲染路径，而钉死的 better-sidebar 徽标契约只提供包裹字符串或数字的中性 pill，且 `null` 会整体隐藏 pill。本包因此先交付值层面的两态（静默 / 计数）；点样式待契约扩展后落地。
- **「重新检测环境」是禁用占位**——检测接线随 mobilecli 子票到来；在真实 source 出现前该控件保持不可用。
- **「最近设备」与行内「打开/启动」是后续界面**——票面点名了最近设备，但已锁空态稿只分组实时来源（模拟器 / USB 真机），连接与启动动作归属引擎子票；待真实 `PhoneBadgeSource` 提供历史后一并落地。
- **中文文案固定**——骨架只带 zh 文案、未接 locale 命名空间；本地化与剩余三态一并推进。
- **内容组件忽略 tab props**——`visible` 门控的拉流暂停从已连接态开始，本阶段 descriptor 不前传任何字段。
