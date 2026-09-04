# Agent Note: 设置页清单跟随 Host 机队；打开面板对比度

Status: implemented

[English](2026-09-03-settings-listing-live-refresh-and-open-panel-contrast.md) | 中文

## 问题

Host 机队与 `simctl` 已是 Shutdown / `offline` 时，设置 → 手机设备清单仍显示「运行中」且「打开面板」可点。页脚已写清单会实时刷新。`createListingPhoneEnvironmentSource` 只在 `redetect` 拉取，且从不 `listing.subscribe()`，因此后续 listing 提交无法通知卡片。HTTP listing 源从不轮询；Host `phone-runtime` 已按 `pollIntervalMs`（默认 5000 ms）轮询 `devices.list`，浏览器也没有 `GET /phone/devices` 的 Host 变更流。

启用态「打开面板」用 `color: var(--dsw-static-neutral-bluish-00)` 叠在 `button-primary-fill` 上。暗色主题主色是浅色，标签消失。

## 决策

设置环境源在首次 `redetect` / `ensureDetected` 之后订阅 listing 提交，并重新发布 ready 清单。该源处于 ready 且仍有卡片订阅者时，每 `PHONE_LISTING_POLL_INTERVAL_MS`（5000 ms，对齐 Host `pollIntervalMs` 默认值）刷新 `GET /phone/devices`。失败的刷新保留上一份已提交清单。卡片控制器只在 `ui-phone.enabled` 为 true 时跟随该源，因此关闭部署不会轮询。后续 `redetect` 探测期间也会暂停轮询；最后一个订阅者离开时停止。

启用态与 hover「打开面板」使用 `color: var(--dsw-alias-label-primary-foreground)`，标签跟随主题前景色叠在主色填充上。

## Alternatives considered

**每次 Host 机队变化都要求点「重新检测」。** 拒绝：页脚已承诺实时刷新，且 Host 已按 5 s 节奏轮询。

**在 `createHttpPhoneListingSource` 内为所有消费者轮询。** 拒绝：关闭部署不得发现设备；listing 源与选择器共享，且没有 enable/ready 阶段。

**订阅 Host listing 变更流。** 拒绝：浏览器只有 `GET /phone/devices`。

**打开面板标签继续使用 `--dsw-static-neutral-bluish-00`。** 拒绝：该静态白色 token 在暗色主题浅色主色填充上不可见。

## 后果

设置清单最多落后 Host 一个轮询周期。关闭插件会取消卡片订阅，从而停止 GET 轮询。测试固定无需第二次 `redetect` 的离线 `getView`、第二次轮询通知、失败轮询保留，以及打开面板 CSS token。
