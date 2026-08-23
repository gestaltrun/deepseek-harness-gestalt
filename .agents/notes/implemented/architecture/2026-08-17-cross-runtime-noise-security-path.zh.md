# Agent Note: 为跨运行时 Noise 安全路径选择 Snow WebAssembly

Status: implemented

[English](2026-08-17-cross-runtime-noise-security-path.md) | 中文

## 问题

Mobile Companion 要求固定的 `Noise_XKpsk3_25519_ChaChaPoly_SHA256` 配对流程与 `Noise_IK_25519_ChaChaPoly_SHA256` 重连流程在 Node 22、Node 24、iOS `WKWebView` 和 Android `WebView` 中表现一致。选择互不相关的原生实现与 JavaScript 实现会扩大多份审计面，并使成功握手不足以证明跨运行时兼容性。从原语构建 X25519、ChaChaPoly、SHA-256 或 Noise 状态转换会产生安全敏感的自有代码，违背仓库的[依赖决策](../process/2026-07-26-dependencies-over-hand-rolling.zh.md)。

实现选择还需要超出快乐路径的证据：官方向量、远端静态密钥认证、新鲜临时密钥、主动攻击拒绝、准确资源上限、降级拒绝，以及不会混淆静态硬件支持封装与 X25519 执行的措辞。

## 决策

选择由证明专属 `Cargo.lock` 固定的 Snow 0.10.0，并将其纯 Rust 25519、ChaChaPoly 与 SHA-256 resolver 一次编译为 WebAssembly。同一份已提交模块在全部四类运行时中执行。轻量 Rust 适配层可以选择协议、提供密钥与 prologue、驱动 Snow 的公开握手及传输 API 并比较结果；不得复制、分叉或替换 Noise 或密码原语。

将有界证明保留在 `scripts/noise-security-path` 下，而不创建产品 package。产品代码不得依赖它。证明拥有两个完整的六消息 Cacophony 向量、XKpsk3 与 IK 流程、双向传输、新鲜临时密钥比较、篡改/stale 配对 transcript/传输重放/乱序/跨配对/降级用例、65,535 字节最大消息往返，以及对 65,536 字节消息的重复拒绝。stale 配对用例在 fresh responder 状态中接受旧第一条消息，发出 fresh 第二条消息，再拒绝旧的认证第三条消息。无密钥快照固定稳定结果，而一次性原生宿主证明实际 WebView 执行。

[跨运行时安全证明](../../../../docs/security/noise-cross-runtime-proof.zh.md)是独立评审入口。Snow 是已选实现，但产品集成与发布仍以独立评审者复现证明、审计依赖与适配层、记录准确环境并解决发现为门禁。模拟器证据绝不表示物理设备硬件保护。

存储声明包含两个独立部分：原生产品代码可以在相应操作系统能力可用时，使用硬件支持设施封装静态私钥材料；本路径中的 X25519 在 Snow WebAssembly 进程内存中执行，不声称硬件支持或不可提取性。

## 考虑过的替代方案

- **分别采用原生 Noise 库与 JavaScript 库：** 这会产生多份实现与行为面，跨运行时一致性会变成互操作项目，而不是单一产物检查。
- **现有 JavaScript Noise package：** 评估的 package 不支持固定 PSK 套件，也不提供所需的维护中且有向量支持的路径，因此无法满足已接受的协议名。
- **从 Web Crypto 或底层曲线及 AEAD 原语实现固定套件：** 这会最大化自有协议与密码状态机代码，即使原型通过自己的测试也予以拒绝。
- **把 WebView 成功加载当作证明：** 加载只能确认产物兼容性，不能确认向量一致、认证、新鲜临时密钥、攻击拒绝或固定资源行为。

## 后果

- 一份已评审 WASM 产物和一张依赖图成为桌面与移动运行时的候选安全实现。
- 证明增加 Rust 与 `wasm-bindgen-cli` 构建前置条件，以及完整矩阵所需的原生模拟器与仿真器前置条件；普通无密钥快照直接使用已提交产物，不需要这些原生工具。
- 已提交 WASM 必须能从锁定源码复现；依赖更新必须重新执行全部向量、攻击、资源和运行时检查，并重新接受独立评审。
- 产品集成仍负责挑战生命周期、中继分帧、原生存储、凭证与撤销行为、后台行为，以及运行期拒绝服务控制。
- 不取代任何现有 Agent Note；“依赖优先于手写”的决策仍是通用规则。
