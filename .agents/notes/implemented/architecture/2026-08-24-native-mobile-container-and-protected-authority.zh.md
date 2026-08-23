# Agent Note: 从仓库内 Capacitor 工程发布原生 Mobile 权限

Status: implemented

[English](2026-08-24-native-mobile-container-and-protected-authority.md) | 中文

## Problem

[Mobile Companion 提案](../../proposed/feature/2026-08-17-mobile-companion.zh.md)选择了轻量原生容器、受保护配对密钥、加密离线内容、应用链接与受控分发，但产品目录只有 Web 源码。实际运行入口通过浏览器存储持久化 Installation 身份与配对权限，Companion Cache 尚未接入，也没有可重复的 App Store 或 Android release-key 产物链路。因此，Web build 成功无法证明原生存储、升级、lifecycle、picker、签名或打包入口行为。

## Decision

`apps/mobile/ios` 与 `apps/mobile/android` 是 `com.alibaba.gestalt.mobile` 的仓库内 Capacitor 工程。Capacitor 会把编译后的 `apps/mobile/src/main.tsx` closure 复制到每个应用；两个工程都不会从 Desktop、Platform、Vite 或 `prototype-companion` 加载可执行应用代码。两个原生工程都注册 `GestaltProtectedStorage`。iOS 使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` 把 UTF-8 值保存为 generic-password Keychain 条目。Android 在 Android Keystore 中创建不可导出的 AES-GCM 密钥，把每个加密 SharedPreferences 值及其存储 key 绑定为 additional authenticated data，每次替换都使用新的系统 IV，并禁用应用备份。产品 composition 要求该原生插件，并在其中保存稳定 Installation id、Mobile Relay grant、96 字节 IK reconnect record、attachment key 与待处理配对恢复。IndexedDB 配对存储仍是可注入的浏览器测试 adapter，打包入口无法选择它。

已鉴权 Account 与 Personal Pairing 会选择一个账号隔离的 Companion Cache 数据库。由配对所有的 attachment material 经过 HKDF-SHA-256 派生的密钥，会使用配对专属 AES-GCM additional data 加密一份带版本的 Workspace、Session 与 transcript projection 快照。只有完整且通过校验的缓存 projection 才能成为 Remote Offline 只读展示；它不能创建已鉴权连接或启用 mutation。真实已鉴权 projection 会替换缓存展示，密封新的缓存快照，并继续以 Desktop 为权威。清除一个 Desktop 的缓存会删除其内容和回执，但不会删除受保护的配对权限。Session 创建、prompt、cancel、interaction settlement 与 attachment offer 都会在进入 transport 前预留不可淘汰的 `prepared` Operation Receipt，并在外部发送尝试之前持久改为 `unknown`。前台重连会向配对范围的 Desktop ledger 查询每个未知 operation id，应用其原始结果或明确的未提交状态，刷新展示，并且绝不重放 mutation。跨进程替换后遗留的 Desktop ledger prepared 记录，会在查询或重复执行时变成持久的 `companion-outcome-unknown` Host failure；它绝不回答 absent，也绝不重复 Host effect。

原生 shell 声明相机权限，并通过 WebView file input 使用操作系统 document picker。`@capacitor/app` 拥有前后台 lifecycle 与 `appUrlOpen`。`deepseek-gestalt://pair?link=...` URL 只把现有完整一次性配对链接送入与粘贴和 QR 相同的 parser；OAuth 凭据与 Account callback 值绝不使用应用 scheme。

`mobile-release` Environment 提供唯一的 version/build 身份、生产公共配置、Android release keystore 与 Apple 上传凭据。Android release build 只把 keystore 解码到 mode-0600 临时目录，校验 signed APK，并删除临时副本。iOS release build 在受保护的 self-hosted macOS ARM64 runner 上执行；缺失 Distribution identity，或 `Gestalt Mobile App Store` profile 过期或不匹配时会拒绝构建；archive 使用 team `MUX3KT56Q6`，export 使用显式 App Store profile mapping。TestFlight 上传是独立的 dispatch 控制步骤。Build artifact、profile、keystore 与 credential 都被忽略且绝不提交。

## Alternatives considered

**因为 WebView origin 稳定而继续把配对权限放在 IndexedDB。** 拒绝，因为稳定 origin 不满足原生受保护存储要求，也不能阻止普通 Web 内容存储拥有长期 Relay 与 reconnect 权限。

**采用通用 secure-storage Capacitor 插件。** 拒绝，因为可用插件 contract 会加入本次发布不需要的迁移和备份行为，而所需能力只是一个小型字符串 key-value 接口，带有明确的 iOS accessibility、Android authenticated encryption 与删除语义。

**只在发布 job 中生成 iOS 与 Android 工程。** 拒绝，因为签名设置、权限、自定义插件、应用链接与原生升级行为将不再是可审查源码，generator drift 还可能在 code review 后改变 candidate。

**在普通 GitHub-hosted runner 上签名 iOS。** 拒绝，因为已批准 Environment 有 Apple 上传凭据，但没有可导出的签名证书或 provisioning-profile secret。受控 self-hosted runner 已持有不可导出的 Distribution identity 与已安装 App Store profile；preflight 会把 workflow 绑定到这些确切资产。

## Consequences

当操作系统保留 Keychain 或 Android 应用数据时，应用升级会保留 Installation 与配对权限；缓存损坏或格式替换可以通过清除可丢弃加密行恢复，无需正常重新配对。Android 卸载会移除应用数据，重装后会创建新 Installation。iOS Keychain 数据可能在卸载后继续存在，因此重装会保留 Installation，直到 iOS 或用户移除对应 Keychain 条目。Simulator 与 emulator build 会校验原生集成，但不声称物理设备 hardware-backed key 属性。

仓库内工程与脚本让 signed candidate 可重复生成，但 artifact 生成不等于 assembled 产品验收。TestFlight 与 signed APK 证据必须标明确切 reviewed commit 以及实际运行 Platform/Desktop；本地导出的中间 IPA、Vite origin 或 prototype 仍不充分。
