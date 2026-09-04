# Agent Note: 侧栏手机选择器跟随 Host 设备清单

Status: implemented

[English](2026-09-04-ui-phone-sidebar-picker-live-listing.md) | 中文

## Problem

Host 已列出的 USB 真机（`GET /phone/devices` 的 `ios.reals[]`）会出现在「设置 → 手机设备」，但不会出现在侧栏「手机」选择器的 USB 真机组。PhoneTab 只在启用/挂载和「重新检测环境」时拉取 fleet。设置 overlay 以自己的 listing 实例每 5000 ms 轮询，写不进 Session Surface 快照。占用设备会把 `tab.meta` 设为 `{ kind: 'device' }`；带「重新检测环境」的 PhoneTab 再也渲染不出来，已连接下拉继续用那份过期快照。Issue #562。

## Decision

PhoneTab 与 PhoneConnectedView 订阅 Session Surface 的 `PhoneListingSource`，并在 tab 已挂载且启用时按 `PHONE_LISTING_POLL_INTERVAL_MS`（5000 ms，Host `phone-runtime` `pollIntervalMs` 默认值）轮询 `GET /phone/devices`。`startPhoneListingPoll` 持有该间隔；失败的刷新保留上一份已提交清单。设置 overlay 可以保留另一份 listing 实例；PhoneTab 与 PhoneConnectedView 使用的 Session Surface listing 自行轮询。

占用不是死胡同。`showPhonePicker` 把标题改回 `手机`、把 `meta` 写成 `{}`（没有 `kind: 'device'`）。`updateTab` 只在 patch 带 `meta` 字段时写入，因此空对象就是选择器载荷。已连接视图的「选择设备」调用该辅助函数，回到带「重新检测环境」的选择器。

## Alternatives considered

**只依赖设置 overlay 轮询。** 拒绝：overlay listing 不会写入选择器与下拉读取的 Session Surface 快照。

**只轮询已连接下拉。** 拒绝：USB 分组在 PhoneTab 上；插入的真机必须在尚未占用设备时出现。

**占用后只能关 tab。** 拒绝：单例「手机」tab 会在整段 layout restore 里藏起「重新检测环境」。

**让 overlay 设置与 Session Surface 共用同一个 listing 对象。** 本票拒绝：overlay 可以保持独立实例；Session Surface 必须自行轮询。

## Consequences

Host 在一个 poll 周期内列出的 USB 真机会出现在选择器 USB 组与占用下拉中，无需点「重新检测环境」。「选择设备」恢复选择器。包测试钉住 USB 组提交、回到选择器，以及下拉随后看到在线真机。

## Related

占用 meta 仍见[已连接视图](../feature/2026-08-28-ui-phone-connected-device-tabs.zh.md)。设置卡轮询仍见[清单驱动卡片](2026-08-28-ui-phone-settings-listing-source.zh.md)。
