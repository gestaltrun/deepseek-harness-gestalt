# Agent Note: 使用真实 Companion 产品链路

Status: proposed

[English](2026-08-22-real-companion-product-path.md) | 中文

## Problem

Mobile Companion 已具备可用于生产的 Account、配对、Relay、附件、Session 与共享 Client 包，但组装后的 Desktop 与 Mobile 链路仍依赖仅用于证明的身份、内存 Platform 存储、捆绑的 localhost 证书、keyless provider、共用附着 id、未认证的一字节同步信号、占位设备和附件值、关闭的全文检索，以及 Mobile 自有的内容 renderer。因此，本地 Vite 与 `prototype-companion` 证据可以通过，而发布产品链路仍未得到证明。已接纳的 Mobile Companion 提案还要求 APNs 与 FCM，但当前产品决策删除推送投递，改为要求前台同步。

## Proposal

产品 Desktop 与 Mobile 只组装已运营的 HTTPS Platform 身份、真实 GitHub Account 流程、持久化 Platform provider 与经过评审的逐配对加密通道。测试身份、内存 provider、测试证书、keyless 握手、固定 Relay 附着 id 与仅用于证明的同步帧只保留在有界测试中；这些测试的名称和断言不得作为产品验收证据。

每个 Personal Pairing 独占 Mobile 与 Desktop 附着身份、路由凭据、应用密钥和认证同步。Snow 通过新鲜临时密钥完成 XKpsk3 配对与 IK 重连。版本化 Encrypted Companion 消息承载同步；Relay authority 由配对派生通道密封，绝不以应用明文或 Platform 可见明文出现。

Mobile 展示已认证 Installation 的名称与平台，通过浏览器相机 API 扫描完整 Pairing Challenge，并保留完整链接回退。两台手机保持独立配对和撤销，不共享密钥、附着 id、设备记录或在线状态。

Mobile 附件使用配对范围的加密 blob capability，并以字节进入现有 Desktop Session 附件路径。Desktop 为产品搜索启用全文 Session provider。Host HTTP 状态、wire 失败、类型化业务错误和超时成为稳定 Companion 结果与可见 Mobile 状态。

Companion Surface 是导出的 DSH Web 组件的手机尺寸组合。Mobile 拥有导航、所选 Desktop 状态和远程权威适配；共享 Web 包拥有 Markdown、代码、图片、工具、diff、审批、Ask User、错误、终端摘要和 composer 展示。导入 Desktop 私有 CSS module 或重新实现这些 renderer 不满足组件复用。

Mobile Companion 不提供推送能力。[仅前台同步决策](../../implemented/simplification/2026-08-22-foreground-only-companion-synchronization.zh.md)删除 APNs 与 FCM adapter、token、payload、持久化、配置、配额、指标、secret、原生依赖与验收要求。进入后台会暂停 Relay 连接；打开应用或回到前台时重新连接，并在启用 mutation 前完成 Desktop 权威同步。只有不携带过期交互权威且不依赖推送投递的 deep link 才可保留。

产品验收运行发布的 Mobile 入口、已运营的非粘性双实例 Platform 与真实 Paired Desktop。`apps/mobile/prototype-companion`、Vite 端口 5173/5174、假身份、内存存储、测试证书与测试专用 provider 禁止作为验收 origin。

## Alternatives considered

**逐个替换 fixture 后提升本地 Companion listen。** 拒绝，因为该 composition 本身拥有假身份、内存权威、localhost 信任和 keyless transport；逐项替换仍会留下第二条产品路径和含糊的验收证据。

**保留 Mobile 自有 renderer，只共享 CSS 与领域类型。** 拒绝，因为即使页面外观相似，行为、无障碍、未知内容回退和交互展示仍会继续漂移。

**把 APNs/FCM 保留为休眠 adapter。** 拒绝，因为休眠的 schema、secret、token 生命周期、配额和原生依赖仍保留不受支持的能力及其运营和隐私义务。

**把本地 Vite 加 Electron 当作组装验收。** 拒绝，因为它不能证明发布的 Mobile 入口、运营身份、持久化双实例路由、设备隔离、原生运行时或真实信任链。

## Acceptance criteria

- 产品入口不能选择本地证明身份、内存 Platform、捆绑证书、keyless 通道、固定附着 id 或一字节同步。
- 两个已认证 Mobile Installation 通过已运营的双实例 Platform，以独立 Device Principal 同时配对并操作一个真实 Paired Desktop。
- 每条 Encrypted Companion 消息及密封 Relay authority 的配对与重连都使用经过评审的 Snow 产品通道。
- 浏览器相机与完整链接配对、加密附件字节、全文 Session 搜索和 Host 失败投影通过真实产品入口。
- Mobile 与 Desktop 对每种共享内容类别执行同一套导出 Web 展示组件。
- 发布源码与配置不含 APNs/FCM capability、token、secret、quota、payload、provider 或原生依赖。
- 产品验收不请求 5173/5174 端口，也不导入 `prototype-companion` 或本地证明 provider。

## Risks

删除推送意味着产品无法提醒后台中的手机；用户必须打开 Mobile Companion 或将其切回前台，应用才能获知 Desktop 当前状态。共享 Web 组件可能需要更深的公共接口，使手机布局保持独立而不暴露 Desktop 权威。真实组装测试仍受已运营 Platform 与通过评审的通道阻塞，生产部署或移动端分发仍需单独授权。
