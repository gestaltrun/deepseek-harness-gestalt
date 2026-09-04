# Agent Note：手机设备群 Service 中的 iOS 真机链路

Status: implemented

[English](2026-08-28-phone-ios-real-device-link.md) | 中文

## 问题

设备 Dock 的 real 分组（#355、#362）能列出物理手机，但没有任何东西保证 iOS 真机可驱动：mobilecli 点按、文本、按键与采集所需的设备端 agent 需要手工安装，重签需要操作者手动执行上游命令，失败以自由文本抵达、没有任何可供 Consumer 分支判断的结构。免费团队签名还会在 7 天后静默过期，链路断掉时既无提示也无复跑入口。

## 决策

`ctx.phoneDevices` 在同一个折叠 Service 上持有真机路径：

- `agentStatus` 与 `installAgent` 以已解析可执行文件的一次性子进程运行上游 `agent status` / `agent install`，使用去除凭据后的父环境与 `agentTimeoutMs` 上限。本包仍绝不下载或 vendor agent 工件——下载归 mobilecli；FSL 依赖边界不变。
- 幂等由本包实现：不带 `force` 时，status 探测直接应答已安装的 agent，不产生任何安装子进程，因此重复调用收敛。`force` 就是重签入口。真机在上游要求所配置的 `provisioningProfilePath`，缺失时经由正常的上游错误路径响亮失败，而不是发明一个本地错误臂。
- 凡关于已安装、已重签真机的应答都携带 `FREE_SIGNING_PROFILE_REMINDER`：免费团队签名 7 天过期，`installAgent(id, { force: true })` 是复跑入口。
- 两种载体——agent 命令文本与上游 JSON-RPC 错误消息——的失败输出由同一个函数分类到闭联错误臂 `device-locked` / `cert-untrusted` / `profile-expired` / `tunnel-failed` / `device-unplugged`，以 `PHONE_REAL_DEVICE_ISSUE` 暴露并由 `PhoneDevicesError.issue` 携带。上游 `-32010` 被刻意排除在分类之外，`phone-stream` 的设备缺失 404 语义得以保全。

分类是模式优先级而非语义理解：第一个命中的臂获胜，profile 过期排在证书措辞之前，因为过期才指明根因。未命中任何臂的消息保持其传输层错误码。

## 已考虑的替代方案

**连 `-32010` 也分类。** 拒绝：`phone-stream` 将 `PHONE_DEVICE_NOT_FOUND` 映射到其设备缺失应答；把设备消失错误改道到 unplugged 臂，会为一个边际的分类收益改变已发布 Consumer 的公开语义。

**对真机目标做本地 profile 必填拒绝。** 拒绝：该要求属于上游，且其消息已经足够精确；并行的本地检查会复制规则并可能与上游命令漂移。

**解析 provisioning profile 取得具体过期日期。** 拒绝：解码 `.mobileprovision` 意味着在这个边界引入 CMS 工具，而提醒文本能更便宜地传达同一事实；profile 保持不透明。

## 后果

Consumer 可以基于 `PhoneRealDeviceIssue` 分支而无需字符串匹配，操作者拿到 7 天提示与具体的复跑入口。CI 只通过 fake mobilecli 垫片钉住链路；硬件在环套件在没有 `DSH_PHONE_REAL_UDID` 时自跳过，不进入覆盖率。真机隧道行为仍取决于所安装的 mobilecli——Service 暴露 `tunnel-failed` 但不持有隧道。
