# @deepseek-ai/dsh-client-ui-phone

[English](README.md) | 中文

「手机」tab 插件：向 `ctx.betterSidebar` 注册表登记 `phone` tab 类型（id `phone`、标题 手机、单色内联 SVG 图标、`order: 55`）。入口恒可达——`available` 永不拒绝，零设备的部署同样能打开选择器实例，落到已锁稿的未连接空态：Android/iOS 平台分段选择、分组设备清单（模拟器 / USB 真机）、USB 占位行与「重新检测环境」控件。

条上只保留一个「手机」tab（`single: true`）。内容按 `meta` 分流：无 serial 是空态；`{ kind: 'device', serial, name }` 占用同一 tab，标题为 `手机·<name>`。「打开」与设备下拉经 `updateTab` 就地切换（决策矩阵轴 1：单例就地切换）。关闭部署会拒绝切换：检测关闭时无法铸造任何流会话。清单行读取 listing wire（`online` 为推导值，`state` 按 #421 `PhoneDeviceRefWire` 契约原样透传）：空态清单与已连接下拉只列在线设备；`state === 'unauthorized'` 的真机仍在空态渲染设计稿警示臂——「真机未授权调试」+ 下一步动作「重新检测」——且不进入下拉。在线行带「打开」按钮；`PHONE_UNRESOLVED` 的清单拉取渲染「未找到 mobilecli」并给出 `npm install -g mobilecli@latest` 命令。选择器内容经 gate source 响应式跟随持久化开关：在设置卡拨动开关，已挂载的「手机连接未启用」说明条同 tick 刷新（并武装首次清单拉取）。

清单把占用设备标为未授权时，已连接内容渲染同一条警示臂（实时流优先于过期清单），并消费 Host `phone-stream` 的同源通道但不 import 它：`POST /phone/session` 以 `format: 'avc'` 铸造签名采集地址，`/phone/ws/io` WebSocket 承载 JSON-RPC `tap` / `gesture` / `text` / `button`，`PhoneH264Surface` 把签名 H264 URL 拉取到 canvas。其播放模块根据 AUD 或完整的 primary-picture slice identity 解析未使用 data partition 的 Annex-B access unit，从 SPS 推导 codec，在背压时等待 `VideoDecoder` dequeue，绘制并关闭每个 `VideoFrame`，再把解码后的显示尺寸报告为触控坐标面。播放要求 SecureContext（Desktop loopback Web Host 满足此条件）及 Chromium WebCodecs AVC 支持；不安全或不支持的运行时会把播放失败送入有界重连/错误臂，不会更换格式。内容按已锁稿状态 ③ 渲染：devbar 对齐 BrowserView 节奏（6×8 边距、28 高控件），承载设备下拉与 H264 徽标；1:2 固定比例画面在面板剩余空间居中（轴 3 格 B）；底部为圆形 返回/主屏幕/最近任务/截图/刷新流 工具条（带已锁稿的 H264 30 fps 说明：流契约无 fps 字段，现为设计稿文案）与触控提示行。点击画面发送 tap，拖动超过 6px 发送 `pointerDown`/`pointerMove`…/`pointerUp` gesture，可打印字符（Enter 为 `\n`）发送 text；「截图」保持禁用，直到会话附件存储就绪。

连接生命周期收敛在 `PhoneConnectionController`（无 React，占用设备一实例）：铸造 → io 打开 → live；`visible: false` 暂停拉流，恢复时重新铸造——签名地址短时效。serial 变化会销毁上一份控制器。中断（`onClose`、`onError`、H264 拉取/解析/解码/绘制失败）进入有界自动重连（3 次线性退避），预算耗尽落到错误卡。`PhoneConnectedView` 在 live、suspended、reconnecting 与 error 阶段之间保留同一份 H264 播放 owner。surface cleanup 会同步请求关闭 fetch reader 与 decoder；新 URL 或设备只在不会 reject 的 settlement 完成后启动，已过时的排队 replacement 永不启动。每次 teardown 都会清空已学习的触控面，因此重连后的 socket 会在首幅新解码帧提供尺寸前拒绝 tap。终态分支——设备离线（铸造 404 或 io `-32010`）、真机调试未授权（上游报文）、被拒绝（403）——跳过重试循环，按已锁稿状态 ④ 渲染带唯一「重新连接」下一步动作的错误卡。渲染层只镜像阶段快照；全部决策留在控制器内，fake gateway 的 spec 逐一证明迁移。

Host 半边注册持久化 `ui-phone` 命名空间（`enabled`，boolean，默认 `false`），并把该 gate 接到 `ctx.phoneEnvironment`。浏览器半边贡献顶层设置分区（`id: phone-devices`，导航标签「手机设备」 / Phone Devices）。方案 C 页面在共享 mobilecli 运行时下方分别显示 Android/iOS 平台卡。Android 卡展示 SDK 组件、来源、下载与磁盘信息、SDK/AVD 根目录、显式许可同意、进度、人工要求、重试和启动操作；设备清单在其下方保持独立。不提供全局 npm、shell 命令或 `PATH` 步骤。本页不是「移动伴侣」：伴侣是人用手机连桌面，这里是设备被控调试。本包 client face 不 import Host phone 包。

Loader `Config.enabled`（boolean，schemastery 校验，默认 `false`）仍是组装默认值。注册不依赖它——关闭时选择器入口仍然可达，选择器内容会在空态上方固定渲染「手机连接未启用」说明条。持久化开关关闭时不发现设备、不拉起 `mobilecli`、不路由任何流。

条状徽标与两块内容读取同一个注入抽象 `PhoneListingSource`（`getBadge(): { onlineCount }` 供每次渲染的徽标读取，`snapshot()` / `refresh()` / `subscribe()` 供两块内容读取）。随包实现消费 Host 的 `GET /phone/devices` 路由：每次拉取都会校验分组清单，emulator 与 simulator 类型归入「模拟器」组、真机归入「USB 真机」组，且只在成功时提交——失败的拉取保留上一份清单。启用时选择器在挂载时拉取一次，并由「重新检测环境」再次拉取；占用内容挂载时也会拉取，使其下拉无需先访问选择器即可点亮。徽标取值：存在在线设备时输出在线台数，否则为 `null`。

组装关系：`tsconfig.client.json` 聚合引用本包；`packages/bundle/web-app/cordis.patch.yml` 携带 `ui-phone` 浏览器行；`packages/bundle/web-app/package.json` 声明依赖。包 invariant 伴生体在同进程 fake 注册表上以真实 cordis fiber 证明 tab 注册/注销对称。

## 模型体验

无，因为浏览器界面、Host 设置命名空间与视频播放不注册提示词、工具 schema、会话事件或提供方请求；模型侧能力归独立消费方所有。

#### KV Cache 影响

无；界面设置与设备状态不会改变模型请求前缀。

## Known Limitations and Deferred Work

- **徽标保真缺口**——pill 节点已 aria-hidden（可访问性 P3：计数不再进入 tab 可访问名），但已锁稿的 灰点（无设备）/ 绿色数字（在线台数）仍需点形与配色渲染路径，而钉死的 better-sidebar 徽标契约只提供包裹字符串或数字的中性 pill，且 `null` 会整体隐藏 pill。本包因此先交付值层面的两态（静默 / 计数）；点样式待契约扩展后落地。徽标回调也看不到渲染它的 tab 实例，因此每个手机 tab 显示的是全队在线台数，而非激活设备的绿点。
- **「截图」禁用**——设计稿把截图存入会话附件；客户端侧暂无可用的附件通道，按钮以 tooltip 禁用渲染，不做假动作。
- **iOS 平台准备仍属后续**——macOS 运行时与模拟器下载归 iOS 平台环境包。
- **「最近设备」与行内「启动」是后续界面**——票面点名了最近设备与模拟器启动，但设备历史与浏览器可达的启动路由都不存在；选择器现阶段只交付「打开」。
- **IME 组合与控制键不上送设备**——可打印字符与 Enter 映射到 `device.io.text`；删除、快捷键与 IME 预编辑需要更完整的文本通道。
- **中文文案固定**——包内只带 zh 文案、未接 locale 命名空间；本地化与 device-dock 剩余状态一并推进。
