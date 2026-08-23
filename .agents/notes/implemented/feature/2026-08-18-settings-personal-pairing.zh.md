# Agent Note: Settings-owned same-account Personal Pairing

Status: implemented

[English](2026-08-18-settings-personal-pairing.md) | 中文

## Problem

Platform 账号识别安装，但不会授予 Desktop 权限。个人配对需要短期能力、已鉴权的同账号交换、明确的人工比对与窄授权设备主体，同时不能把远程访问状态暴露到既有 Session Surface 各处。所选 Noise 实现仍受独立评审要求约束，因此生命周期交付不能把仅用于证明的依赖静默变成产品密码实现。

## Decision

`@deepseek-ai/dsh-remote-access` 是拥有手机访问与个人配对生命周期的远程访问模块。其公开服务要求 Platform 账号鉴别会话拥有的安装 id 与类型，拥有挑战、待确认与已确认状态迁移，串行执行变更，并且仅在 Desktop 确认后授予 `companion-surface` 设备主体。带品牌的 id 区分挑战、rendezvous、完成、待确认配对、个人配对、设备主体与活跃密钥引用。调用方永远不能自行声明安装角色。

Desktop 与 Mobile 的密码行为通过 `PairingHandshakeProvider` 进入。生命周期向它传递全新的 32 字节邀请密钥，仅从返回的握手哈希派生显示词，并将每次激活的公开密钥引用与提供方私有分配句柄分开。分配在激活返回后立即归清理流程持有，因此公开引用解析、id 生成、碰撞或提交失败都只能销毁本次新分配。终态结果与资源清理相互独立：重试会返回已提交结果，不会重复握手或激活；销毁失败的资源仍由清理记录持有，提供方释放资源时会聚合处理全部保留资源。每个已鉴权安装都有固定的存活挑战、待确认配对和保留记录总量上限。清理完成的重放投影在五分钟后淘汰，清理失败的终态记录则继续占用容量，直到销毁成功。挑战创建时就调度过期任务。共享 authority 的 dispose 仍会结算本实例创建的存活挑战，避免创建进程退出后永久占用每安装上限。生成 id 碰撞不能覆盖既有记录。

`remote-access-http` 消费 `ctx.remoteAccess`；`remote-access-client` 为 Host 拥有的 Desktop 控制器与 Mobile 控制器校验 JSON 和带品牌的 id。Mobile 区分尚未发送的尝试、可能已经提交的请求和待确认结果，分别将它们保留到邀请过期、服务端重放期限或明确终态，并以相同的完成 id 和握手字节重试。Desktop 账号退出与 Mobile 卸载会停用各自按账号划分的生命周期拥有者：投影与重试状态会清除，计时器停止，包括浏览器相机扫码在内的进行中工作排空，后续操作在重新激活前都会失败。组装后的 loader 场景使用 `DevelopmentKeylessPairingHandshakeProvider`，让提供方、HTTP 消费方和共享传输通过真实环回服务器运行。Desktop 与 Mobile 开发入口可以通过显式环境标志选择各自的真实控制器。生产环境在独立 Snow 评审接纳产品提供方前保持关闭，任何生产路径都不会导入无密钥实现。无密钥组装验收、精确两分钟边界与 Settings 外壳放置证明见[个人配对组装验收说明](../testing/2026-08-19-personal-pairing-assembled-acceptance.md)。

既有 Desktop `手机配对` 设置区拥有手机访问开关、QR／完整链接挑战、认证词、确认、拒绝与已配对设备列表。QR 生成使用维护中的零依赖 `uqr` 编码器。Mobile 通过粘贴或浏览器相机 QR 扫描接受同一个完整链接，并等待 Desktop 确认。不会注册新的 Session 标题栏、侧栏、批准、编辑器或离线界面。

## Alternatives considered

**直接集成 proof-local Snow WebAssembly。** 这会越过独立评审要求，并把可复现 evidence 变成未经评审的产品 dependency。可替换 adapter 让产品 composition 保持 fail-closed。

**把 Platform Account identity 当作 Desktop authorization。** 这会折叠 identity 与 capability 边界。Remote Access 只在 pairing 期间比较 Account id，并创建使用独立 key、可独立 revoke 的 Device Principal。

**提供手输短码。** 低熵 fallback 会形成第二条更弱的协议。camera 与 non-camera flow 携带同一个完整 invitation link。

**把 pairing status 加到普通 Desktop chrome。** 常驻 Session UI 会把功能扩展到 Settings 以外并改变无关 offline 与 approval state。既有 Settings slot 是唯一 Desktop presentation owner。

## Consequences

公开生命周期与真实设置／Mobile 控制器可以在不声称产品加密的情况下接受评审与测试。跨账号、安装角色、过期、取消、拒绝、并发、清理重试、确认前不可用、碰撞与窄授权行为固定在同一接口及同一个已鉴权 HTTP 消费方。生产配对仍受独立安全评审阻挡；challenge 与确认状态仍为单进程，而独立的[无状态双实例 Relay](../architecture/2026-08-18-stateless-two-instance-remote-relay.md)拥有在线 route attachment 与密文 forwarding。
