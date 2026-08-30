# @deepseek-ai/dsh-client-ui-phone

[English](README.md) | 中文

「手机」tab 插件：向 `ctx.betterSidebar` 注册表登记 `phone` tab 类型（id `phone`、标题 手机、单色内联 SVG 图标、`order: 55`）。入口恒可达——`available` 永不拒绝，零设备的部署同样能打开选择器实例，落到已锁稿的未连接空态：Android/iOS 平台分段选择、分组设备清单（模拟器 / USB 真机）、USB 占位行与「重新检测环境」控件。

条上只保留一个「手机」tab（`single: true`）。内容按 `meta` 分流：无 serial 是空态；`{ kind: 'device', serial, name }` 占用同一 tab，标题为 `手机·<name>`。「打开」与设备下拉经 `updateTab` 就地切换（决策矩阵轴 1：单例就地切换）。关闭部署会拒绝切换：检测关闭时无法铸造任何流会话。清单行读取 listing wire（`online` 为推导值，`state` 按 #421 `PhoneDeviceRefWire` 契约原样透传）：空态清单与已连接下拉只列在线设备；`state === 'unauthorized'` 的真机仍在空态渲染设计稿警示臂——「真机未授权调试」+ 下一步动作「重新检测」——且不进入下拉。在线行带「打开」按钮。选择器内容经 gate source 响应式跟随持久化开关：在设置卡拨动开关，已挂载的「手机连接未启用」说明条同 tick 刷新（并武装首次清单拉取）。

清单把占用设备标为未授权时，已连接内容渲染同一条警示臂（实时流优先于过期清单），并消费 Host `phone-stream` 的同源通道但不 import 它：`POST /phone/session` 以 `format: 'avc'` 铸造签名采集地址，`/phone/ws/io` WebSocket 承载 JSON-RPC `tap` / `gesture` / `text` / `button`，签名 H264 URL 用原生 `<img>` 播放并以图片自然尺寸作为触控坐标面。内容按已锁稿状态 ③ 渲染：devbar 对齐 BrowserView 节奏（6×8 边距、28 高控件），承载设备下拉与 H264 徽标；1:2 固定比例画面在面板剩余空间居中（轴 3 格 B）；底部为圆形 返回/主屏幕/最近任务/截图/刷新流 工具条（带已锁稿的 H264 30 fps 说明：流契约无 fps 字段，现为设计稿文案）与触控提示行。点击画面发送 tap，拖动超过 6px 发送 `pointerDown`/`pointerMove`…/`pointerUp` gesture，可打印字符（Enter 为 `\n`）发送 text；「截图」保持禁用，直到会话附件存储就绪。

连接生命周期收敛在 `PhoneConnectionController`（无 React，占用设备一实例）：铸造 → io 打开 → live；`visible: false` 暂停拉流，恢复时重新铸造——签名地址短时效。serial 变化会销毁上一份控制器。中断（`onClose`、`onError`、采集元素错误）进入有界自动重连（3 次线性退避），预算耗尽落到错误卡。终态分支——设备离线（铸造 404 或 io `-32010`）、真机调试未授权（上游报文）、被拒绝（403）——跳过重试循环，按已锁稿状态 ④ 渲染带唯一「重新连接」下一步动作的错误卡。渲染层只镜像阶段快照；全部决策留在控制器内，fake gateway 的 spec 逐一证明迁移。

Host 半边在 settings 提供方组装时注册持久化 `ui-phone` 命名空间（`enabled`，boolean，默认 `false`）。浏览器半边贡献顶层设置分区（`id: phone-devices`，导航标签「手机设备」 / Phone Devices），分区主体就是六态环境向导。本页不是「移动伴侣」：伴侣是人用手机连桌面，这里是设备被控调试。向导拥有关闭 / 探测中 / Android 向导 / iOS 向导 / 就绪清单 / 可恢复错误行。命令级安装指引带「复制」按钮，剪贴板内容就是稿中的 `sdkmanager` / `avdmanager` / `emulator` / `xcodebuild` / `xcrun simctl` 命令。每条错误行共用动词「下一步动作」。检测数据经窄接口 `PhoneEnvironmentSource` 进入。随包实现包装选择器已在用的 Host `GET /phone/devices` 清单：成功拉取可到达探测中、两端向导与就绪清单；缺失或拒绝的设备路由回落到探测失败行。本包不 import `phone-runtime` 与 `phone-stream`。

Loader `Config.enabled`（boolean，schemastery 校验，默认 `false`）仍是组装默认值。注册不依赖它——关闭时选择器入口仍然可达，选择器内容会在空态上方固定渲染「手机连接未启用」说明条。持久化开关关闭时不发现设备、不拉起 `mobilecli`、不路由任何流。

条状徽标与两块内容读取同一个注入抽象 `PhoneListingSource`（`getBadge(): { onlineCount }` 供每次渲染的徽标读取，`snapshot()` / `refresh()` / `subscribe()` 供两块内容读取）。随包实现消费 Host 的 `GET /phone/devices` 路由：每次拉取都会校验分组清单，emulator 与 simulator 类型归入「模拟器」组、真机归入「USB 真机」组，且只在成功时提交——失败的拉取保留上一份清单。启用时选择器在挂载时拉取一次，并由「重新检测环境」再次拉取；占用内容挂载时也会拉取，使其下拉无需先访问选择器即可点亮。徽标取值：存在在线设备时输出在线台数，否则为 `null`。

组装关系：`tsconfig.client.json` 聚合引用本包；`packages/bundle/web-app/cordis.patch.yml` 携带 `ui-phone` 浏览器行；`packages/bundle/web-app/package.json` 声明依赖。包 invariant 伴生体在同进程 fake 注册表上以真实 cordis fiber 证明 tab 注册/注销对称。

## Model Experience

无。本包只注册侧栏 tab 与设置卡并渲染 HTML；不贡献 prompt 段、工具 schema、流或会话事件，启用闸门也不增加任何模型可见面。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## Known Limitations and Deferred Work

- **徽标保真缺口**——pill 节点已 aria-hidden（可访问性 P3：计数不再进入 tab 可访问名），但已锁稿的 灰点（无设备）/ 绿色数字（在线台数）仍需点形与配色渲染路径，而钉死的 better-sidebar 徽标契约只提供包裹字符串或数字的中性 pill，且 `null` 会整体隐藏 pill。本包因此先交付值层面的两态（静默 / 计数）；点样式待契约扩展后落地。徽标回调也看不到渲染它的 tab 实例，因此每个手机 tab 显示的是全队在线台数，而非激活设备的绿点。
- **裸 `avc` 播放属于 Host/解码器票**——实时画面只请求 H264（`POST /phone/session` 带 `format: 'avc'`）并加载签名的 `h264` URL；基本流的 MSE/WebCodecs 封装不是本包的工作。
- **「截图」禁用**——设计稿把截图存入会话附件；客户端侧暂无可用的附件通道，按钮以 tooltip 禁用渲染，不做假动作。
- **设置卡从设备清单推断环境**——Host `phoneDevices` 不在线上发布 adb/SDK/Xcode 探测事实，因此一份成功的空清单仍会打开平台向导（macOS 上为 iOS，否则为 Android），而不是按二进制逐项列出检查表。
- **「最近设备」与行内「启动」是后续界面**——票面点名了最近设备与模拟器启动，但设备历史与浏览器可达的启动路由都不存在；选择器现阶段只交付「打开」。
- **IME 组合与控制键不上送设备**——可打印字符与 Enter 映射到 `device.io.text`；删除、快捷键与 IME 预编辑需要更完整的文本通道。
- **中文文案固定**——包内只带 zh 文案、未接 locale 命名空间；本地化与 device-dock 剩余状态一并推进。
