# Agent Note: phone-stream 设备清单路由与 ui-phone 清单 source

Status: implemented

[English](2026-08-28-phone-device-listing-route.md) | 中文

## Problem

移动设备底座推进到 #407 时，Host 只暴露 `POST /phone/session`：没有任何路由应答设备清单，`ui-phone` 随包的 `NULL_PHONE_BADGE_SOURCE` 是空实现，选择器行、已连接下拉与条状徽标数字全部不亮。清单路由要喂给浏览器 tab：不能加 token，不能改 `phone-runtime` 与 `tool-phone` 的公开语义，也不能让单个 Consumer 反向决定 Service 契约。

## Decision

`phone-stream` 在与会话铸造相同的 `/api` 信任栅栏之后（仅 GET、精确路径）应答 `GET /phone/devices`：handler 调用 `ctx.phoneDevices.listDevices()`，把每个设备条目投影为文档化的 `id` / `name` / `kind` / `online`（外加 GUI 错误臂消费的可选 `unauthorized` 标记与 `osVersion` 说明） 响应字段，按 `android` / `ios.simulators` / `ios.reals` 分组。投影是显式的：runtime 分组条目物理上携带上游 `platform` 字段，而公开类型 `PhoneDeviceRef` 早已擦除它；原样转发等于把该内部字段烤进新的响应体。

`ui-phone` 用 `PhoneListingSource`（`getBadge`、`snapshot`、`refresh`、`subscribe`）替换空 source，由 `createHttpPhoneListingSource` 消费该路由。每次刷新都校验响应字段，emulator 与 simulator 类型归入「模拟器」组、真机归入「USB 真机」组，且只在成功时提交——`snapshot()` 在两次提交之间保持同一个冻结引用，因此两块 tab 内容都能把它坐进 `useSyncExternalStore`（与每 tab 连接控制器相同的持有型 observable 先例；better-sidebar tab 宿主没有 slot hook 通道）。选择器仅在启用闸门打开时于挂载时拉取（关闭部署仍然不发现任何设备），并由现已启用的「重新检测环境」再次拉取；已连接 tab 挂载时同样拉取，布局恢复的下拉无需先访问选择器即可点亮。

## Alternatives considered

**像采集 URL 一样给清单签名。** 否决：token 防的是跨源帧加载，而清单喂给的是 `/api` 栅栏已覆盖的同源渲染代码；签名只会徒增铸造往返，防不了栅栏之外的任何威胁。

**原样转发 `listDevices()`。** 否决：runtime 分组条目物理上包含上游 `platform` 字段；把它烤进响应体会让路由耦合到公开类型已丢弃的 provider 内部。

**保留同步 `listDevices(platform)` 接口并在 `PhoneTab` 里用本地刷新计数器。** 否决：异步设备队终究需要提交通知；计数器会让已连接下拉等到一次无关重渲染才更新，并把同一份清单拆到两条更新路径上。

## Consequences

选择器行、「打开」动作、已连接下拉与徽标在线台数读到真实设备数据：没有新依赖，也没有改 `phone-runtime`。刷新失败保留已提交清单并重新武装按钮；徽标取值仍只在条带重渲染时更新（即文档记载的 better-sidebar pill 限制）。插件标签页的环境卡仍读取 `PhoneEnvironmentSource`——环境向导与设备清单是两条独立的缝。
