# Agent Note: Companion 仅在前台同步

Status: implemented

[English](2026-08-22-foreground-only-companion-synchronization.md) | 中文

## 问题

后台提醒可以通知用户 Desktop 的审批、问题、完成或失败需要关注，但仓库只有协议记录、令牌生命周期、提供方适配器、配额和测试，并没有发布的原生投递链路。保留这项休眠能力会带来凭证、持久化、隐私、撤销、兼容性和运营义务。通知状态也可能在用户操作前过期，因此它永远不能授权 Desktop mutation。

## 决策

Mobile Companion 只在用户打开应用或把应用切回前台后获取当前状态。进入后台会停止 Relay WSS 连接。回到前台会与选中的 Paired Desktop 重新连接。每个确认的物理 attachment 都会启动一个 Mobile 同步 generation；connection loss 与 transport error 会在内部重连前清除 `socketOpen`、`synchronized` 和 active generation。Relay ciphertext 不能把同步标记为完成：由 #217 所有的已鉴权 Encrypted Companion decoder 必须解码受支持、有版本的 Desktop resync message，并调用 `bindValidatedDesktopResync` 返回的 generation-bound receiver。过期 receiver 不能授权替换 socket。`companionMayMutate` 随后才允许 Session 创建、提示词、取消、审批、人机问题回答、附件及其他 mutation；在此之前，每个 helper 与最终发送控制器都会 fail closed。

产品不包含推送投递能力。发布源码与配置不包含 APNs 和 FCM adapter、payload 记录、登记 token、持久化、撤销清理、配额、指标类别、部署 secret、原生依赖、HTTP 操作或通知 deep link。配对链接仍然保留，因为它只携带一个短期 Pairing Challenge，不携带过期交互权威。

仓库级 `verify-companion-no-push` 门禁扫描发布的 application、已跟踪 build 配置、package、example、native、Python、website、workflow、script、生成源码、manifest 与依赖 lock 路径，同时排除测试、说明文档和已知生成输出。它拒绝提供方 symbol 与 operation、单复数 device-token 字段、token repository、原生通知依赖、权限与 API、厂商原生 asset 文件名及过时发布证据，同时允许普通数组 `push()` 调用。Mobile 生命周期与 mutation 测试证明进入后台时停止连接、串行前台和内部重连、拒绝过期 generation、拒绝把原始 ciphertext 当作同步、各 mutation 路径 fail closed，以及解除配对时移除 grant。发布的 `main.tsx` 与 keyless snapshot 调用同一个 `mountMobileEntry` composition，由它拥有提供给共用 Web 组件的 `MobileCompanionSurface`。snapshot 会让一个此前已鉴权的 Session 经历物理重连，并钉住创建、提示词、取消、附件、审批和 Ask User 控件在当前 generation 完成已验证同步前保持 disabled。

该决策实现[真实 Companion 产品链路](../../proposed/architecture/2026-08-22-real-companion-product-path.zh.md)中的通知移除切片。旧的无内容通知决策已整合到此处，因为没有生产 schema、配置、migration、兼容行为、文档承诺或支持性行为测试继续存在。

## 曾考虑的替代方案

**保留休眠 adapter 与协议记录。** 拒绝，因为未使用的 schema、token store、配额、提供方 payload 和 secret 名称仍会保留不受支持的能力及其隐私和运营义务。

**删除厂商 adapter，但保留 token 与提示兼容性。** 拒绝，因为没有发布的 Mobile 产品依赖这些格式，预发布仓库也不承诺未发布链路的兼容性。部分删除会保留最广的安全敏感表面，却不能投递提醒。

**保留独立 `ctx.remotePush` capability。** 拒绝，因为通用 Platform 通知总线会把 token 与投递生命周期从拥有它们的 Remote Access route 和撤销生命周期中拆开。产品能力已删除后，休眠 service seam 只会保留不受支持的 schema 与所有权，不会深化仍在运行的模块。

**把厂商 payload builder 留在 Mobile。** 拒绝，因为 APNs 与 FCM payload 由提供方基础设施发送，而不是由后台中的 Mobile 进程发送。由 Mobile 所有既不能形成可投递的提供方路径，也不能消除提供方访问与隐私义务；推送删除后，没有产品层拥有厂商 payload 构造。

**让 WSS 保持在线，或在后台执行 silent synchronization。** 拒绝，因为移动操作系统不为本产品提供可靠的后台执行约定。前台重连让生命周期只有一个明确所有者，并获得当前 Desktop 权威状态。

**允许通知 action 结算交互。** 拒绝，因为通知创建后，审批或问题可能已经变化。每项 mutation 都必须在鉴权同步后观察当前 Desktop 状态。

## 后果

Mobile Companion 无法提醒后台中的手机。用户必须打开应用或把应用切回前台，才能获知 Desktop 当前状态。作为交换，Platform 不存储设备通知 token，不需要移动通知提供方凭证，也不拥有投递配额、payload 或失败遥测。

重新引入后台提醒需要一项新的产品决策，包含真实 iOS 与 Android 投递链路、明确的提供方隐私与保留规则、部署管理的凭证、token 撤销语义、过期交互保护、原生生命周期证据，以及对缺席门禁的更新。后台投递仍不能授予 mutation 权威。
