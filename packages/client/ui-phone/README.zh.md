# @deepseek-ai/dsh-client-ui-phone

[English](README.md) | 中文

「手机」tab 插件：向 `ctx.betterSidebar` 注册表登记 `phone` tab 类型（id `phone`、标题 手机、单色内联 SVG 图标、`order: 55`）。入口恒可达——`available` 永不拒绝，零设备的部署同样能打开选择器实例，落到已锁稿的未连接空态：Android/iOS 平台分段选择、分组设备清单（模拟器 / USB 真机）、USB 占位行与「重新检测环境」控件。

条上只保留一个「手机」tab（`single: true`）。内容按 `meta` 分流：无 serial 是空态；`{ kind: 'device', serial, name }` 占用同一 tab，标题为 `手机·<name>`。「打开」与设备下拉经 `updateTab` 就地切换（决策矩阵轴 1：单例就地切换）。关闭部署会拒绝切换：检测关闭时无法铸造任何流会话。清单行读取 listing wire（`online` 为推导值，`state` 按 #421 `PhoneDeviceRefWire` 契约原样透传）：空态清单与已连接下拉只列在线设备；`state === 'unauthorized'` 的真机仍在空态渲染设计稿警示臂——「真机未授权调试」+ 下一步动作「重新检测」——且不进入下拉。Android USB 引导说明 USB 调试；iOS 引导说明解锁、信任、Developer Mode 与设备控制代理。在线行带「打开」按钮；`PHONE_UNRESOLVED` 的清单拉取会引导用户前往「设置 → 手机设备」使用托管 mobilecli 准备，不提供全局安装命令。选择器内容经 gate source 响应式跟随持久化开关：在设置卡拨动开关，已挂载的「手机连接未启用」说明条同 tick 刷新（并武装首次清单拉取）。

清单把占用设备标为未授权时，已连接内容渲染同一条警示臂（实时流优先于过期清单），并消费 Host `phone-stream` 的同源通道但不 import 它：`POST /phone/session` 铸造签名 H264 与 MJPEG 采集地址，并返回设备类别的首选编码；`/phone/ws/io` WebSocket 承载 JSON-RPC `tap` / `gesture` / `text` / `button`。Android 设备与 iOS 真机首先使用 H264；iOS 模拟器因 mobilecli 会拒绝该设备类别的 AVC 而直接使用 MJPEG。`PhoneH264Surface` 把 H264 拉取到 canvas；其播放模块根据 AUD 或完整的 primary-picture slice identity 解析未使用 data partition 的 Annex-B access unit，从 SPS 推导 codec，在背压时等待 `VideoDecoder` dequeue，并绘制、关闭每个 `VideoFrame`。H264 拉取、协议、解析、支持、解码、绘制或零帧结束失败时，同一份已铸造 session 与 io socket 会切换到 MJPEG URL；MJPEG 图像的 `naturalWidth` 与 `naturalHeight` 成为触控坐标面，只有 MJPEG 也失败才进入有界重连。devbar 显示实际渲染的编码；因流契约没有 fps 字段，已锁稿的 30 fps 文案只保留在 H264。1:2 固定比例画面在面板剩余空间居中，底部保留圆形 返回/主屏幕/最近任务/截图/刷新流 工具条与触控提示行。点击画面发送 tap。按下时捕获 pointer；移动超过 6px 后，起点与松开经 `phoneSwipeActions` 编成一次 WDA swipe（[编码](../../../.agents/notes/implemented/bug-fix/2026-09-02-phone-ios-wda-swipe-gesture.zh.md)）。合并后的触控板滚动沿纵轴发送同一条 swipe。Pointer 取消时释放捕获且不发送不完整 gesture。可打印字符（Enter 为 `\n`）发送 text；「截图」保持禁用，直到会话附件存储就绪。

连接生命周期收敛在 `PhoneConnectionController`（无 React，占用设备一实例）：铸造 → io 打开 → 首选编码 live → 首选编码为 H264 时同 session MJPEG fallback；`visible: false` 暂停拉流，恢复时重新铸造——签名地址短时效。serial 变化会销毁上一份控制器；socket 中断或 MJPEG 失败进入有界自动重连（3 次线性退避），预算耗尽落到错误卡。`PhoneConnectedView` 在 live、fallback、suspended、reconnecting 与 error 阶段之间保留同一份 H264 播放 owner。surface cleanup 会同步请求关闭 fetch reader 与 decoder；新 H264 URL 或设备只在不会 reject 的 settlement 完成后启动，已过时的排队 replacement 永不启动。每次 teardown 与格式切换都会清空已学习的触控面，因此 tap 会等待当前 renderer 提供 H264 解码尺寸或 MJPEG natural 尺寸。设备离线（铸造 404 或 io `-32010`）、真机调试未授权（上游报文）与被拒绝（403）会跳过重试。Host `POST /phone/session` 会在签发前安装可恢复的缺失 iOS 真机 agent，因此打开面板不会先被 `PHONE_AGENT_MISSING` 挡住。`PhoneConnectionController.recoverAgent` 仍用于残留缺失、强制重装与受限失败；已托管会话耗尽画面重试后会复检 agent；已安装但无法产出画面时提供强制重装。`PHONE_REAL_DEVICE_ISSUE` 把设备锁定、证书未信任、profile 过期、tunnel 失败与设备断开分别保留为独立卡。未配置 provisioning 时使用单独的 `PHONE_AGENT_PROFILE_REQUIRED` 卡，引导设置 `provisioningProfilePath`；界面不会宣称自己能够创建签名 identity、profile、Developer Mode、解锁或信任。安装/重装是唯一主按钮，「重新检测」使用次级样式。渲染层只镜像阶段快照；全部决策留在 controller 内，fake gateway 的 spec 逐一证明迁移。

Host 半边注册持久化 `ui-phone` 命名空间（`enabled`，boolean，默认 `false`），并把该 gate 接到 `ctx.phoneEnvironment`。浏览器半边贡献顶层设置分区（`id: phone-devices`，导航标签「手机设备」 / Phone Devices）。方案 C 页面在共享 mobilecli 运行时下方分别显示 Android/iOS 平台卡。Android 卡展示 SDK 组件、来源、下载与磁盘信息、SDK/AVD 根目录、显式许可同意、进度、人工要求、重试和启动操作。iOS 卡在 Host 持有的一键准备期间提供取消入口，被动检测期间不提供；Windows 与 Linux 上会用一段同时说明 iOS Simulator 与 iPhone 真机控制限制的不可用内容替代准备组件和操作。设备清单在两张卡下方保持独立。每个在线设备行都提供主操作「打开面板」；Desktop 设置 overlay 会把所选设备转交给 Session Surface，由后者读取本次选择独享的 Host 清单、等待持久 gate 稳定、重新确认在线设备，再创建或聚焦单例「手机」tab 并展开右侧面板。离线行保持禁用，默认模拟器的启动操作仍归对应平台卡。不提供全局 npm、shell 命令或 `PATH` 步骤。本页不是「移动伴侣」：伴侣是人用手机连桌面，这里是设备被控调试。本包 client face 不 import Host phone 包。

Loader `Config.enabled`（boolean，schemastery 校验，默认 `false`）仍是组装默认值。注册不依赖它——关闭时选择器入口仍然可达，选择器内容会在空态上方固定渲染「手机连接未启用」说明条。持久化开关关闭时不发现设备、不拉起 `mobilecli`、不路由任何流。

条状徽标与两块内容读取同一个注入抽象 `PhoneListingSource`（`getBadge(): { onlineCount }` 供每次渲染的徽标读取，`snapshot()` / `refresh()` / `subscribe()` 供两块内容读取）。随包实现消费 Host 的 `GET /phone/devices` 路由：每次拉取都会校验分组清单，emulator 与 simulator 类型归入「模拟器」组、真机归入「USB 真机」组，且只在成功时提交——失败的拉取保留上一份清单。启用时选择器在挂载时拉取一次，并由「重新检测环境」再次拉取；占用内容挂载时也会拉取，使其下拉无需先访问选择器即可点亮。首次检测完成后，设置页清单跟随 listing 提交，并在 ready 期间每 5000 ms（Host `phone-runtime` `pollIntervalMs` 默认值）刷新 `GET /phone/devices`；失败的刷新保留上一份已提交清单。徽标取值：存在在线设备时输出在线台数，否则为 `null`。

组装关系：`tsconfig.client.json` 聚合引用本包；`packages/bundle/web-app/cordis.patch.yml` 携带 `ui-phone` 浏览器行；`packages/bundle/web-app/package.json` 声明依赖。包 invariant 伴生体在同进程 fake 注册表上以真实 cordis fiber 证明 tab 注册/注销对称。

Android session 在 runtime 能用系统 Annex-B encoder 替换畸形 mobilecli AVC 响应时继续显示 H264。托管 Android 的控制请求被拒绝后会立即检查设备 agent；agent 缺失时错误卡保留一键安装。OEM 仍可能要求用户在手机上确认 USB 安装或调试安全开关。`INSTALL_FAILED_USER_RESTRICTED` 使用独立、可重试的提示卡，不要求用户手工下载安装器或执行命令。

## 模型体验

无，因为浏览器界面、Host 设置命名空间与视频播放不注册提示词、工具 schema、会话事件或提供方请求；模型侧能力归独立消费方所有。

#### KV Cache 影响

无；界面设置与设备状态不会改变模型请求前缀。

## Known Limitations and Deferred Work

- **徽标保真缺口**——pill 节点已 aria-hidden（可访问性 P3：计数不再进入 tab 可访问名），但已锁稿的 灰点（无设备）/ 绿色数字（在线台数）仍需点形与配色渲染路径，而钉死的 better-sidebar 徽标契约只提供包裹字符串或数字的中性 pill，且 `null` 会整体隐藏 pill。本包因此先交付值层面的两态（静默 / 计数）；点样式待契约扩展后落地。徽标回调也看不到渲染它的 tab 实例，因此每个手机 tab 显示的是全队在线台数，而非激活设备的绿点。
- **「截图」禁用**——设计稿把截图存入会话附件；客户端侧暂无可用的附件通道，按钮以 tooltip 禁用渲染，不做假动作。
- **「最近设备」与行内「启动」是后续界面**——设备历史与选择器行内启动控件仍不存在；选择器只交付「打开」，默认模拟器启动由「手机设备」设置页负责。
- **IME 组合与控制键不上送设备**——可打印字符与 Enter 映射到 `device.io.text`；删除、快捷键与 IME 预编辑需要更完整的文本通道。
- **中文文案固定**——包内只带 zh 文案、未接 locale 命名空间；本地化与 device-dock 剩余状态一并推进。
