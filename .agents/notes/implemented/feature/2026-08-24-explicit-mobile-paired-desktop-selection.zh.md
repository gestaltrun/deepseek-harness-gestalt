# Agent Note: 显式选择一个已保留 Paired Desktop

Status: implemented

[English](2026-08-24-explicit-mobile-paired-desktop-selection.md) | 中文

## Problem

Mobile 会保留多组 Personal Pairing 密钥与 Relay grant，但产品会隐式使用最后插入的记录。页面既不能列出也不能选择另一台 Paired Desktop，解除配对还会擦除已登录 Account 范围内的所有 pairing。这样，后续 pairing 可能在没有具名用户选择时替换实际 Session authority，而移除一台 Desktop 会破坏无关授权。

## Decision

账号隔离的受保护 pairing 文档使用版本 2。它原子保存一组有界独立 pairing 记录，以及一个可选 selected pairing id。每条完整记录拥有自己的 Personal Pairing id、Mobile Relay grant、Snow reconnect state、attachment key，以及只从已鉴权 `foreground-sync` 获得的可选 Desktop 名称。该文档会拒绝其他版本、重复 Personal Pairing id、缺少完整权限的 selected id、畸形 secret 字节和超过 retained-pairing 上限的记录。Account 选择会串行执行 load 与 save，把每份 secret 复制进 active scope，并清零转移来的 buffer。

完成 Personal Pairing 会选择这台新 Desktop，因为 pairing action 本身就是显式行为。之后的选择是另一项由人触发的 action。`MobilePairingController` 会让当前 mutation authority 失效，释放上一组 projection 与 cache binding 但不删除已存内容，并排空旧 Relay lifecycle，然后才持久化另一项选择。它会在所选 grant 的重连 Relay lifecycle 获得首个 attachment 前，发布 durable selection 并绑定该 Desktop 最后确认的 Companion Cache。因此，Remote Offline 与 Platform capacity shedding 期间仍可读取缓存并看到所选 Desktop，而每项 mutation 会保持 disabled，直到当前 Snow channel 完成鉴权与同步。已被替换的 Relay activation 不能把失败投影到更新的 selection generation。

Mobile 页面按稳定顺序列出每组 retained pairing，准确标记一个 selected Desktop，只使用已鉴权 Desktop 名称，并在尚未观察到名称时展示不透明 pairing id。页面允许在不删除已有记录的情况下配对另一台 Desktop。解除配对只撤销所选 Personal Pairing，只删除其 Companion Cache 与 Operation Receipt，只清零它的本地 secret，并且不自动回退选择。其他 pairing 会继续列出，直到用户选择其中一组。

Paired Desktop 选择属于 endpoint 本地行为。它不会新增 Relay 或 Encrypted Companion message，也绝不跨 Desktop 合并 Session、Workspace、cache、receipt 或 attachment authority。所选 pairing 的 grant 会在 Relay attachment 前选择一个 route 与 pairing selector；每项 mutation 仍绑定当前已鉴权物理 generation。

## Verification

Vault 测试会通过 IndexedDB 与原生受保护存储 adapter 持久化两组独立 grant、名称、密钥、reconnect record 和显式 selection，并证明重复 id 拒绝、只释放所选记录及账号隔离。Controller 测试证明在激活新 grant 前会释放旧 projection 与 Relay，持久保存 offline 与 capacity-shed selection，拒绝 stale activation，只在 Platform 撤销所选记录，保留另一组 pairing，并且在移除后不做隐式选择。独立的英文与中文打包 Mobile snapshot 会先渲染本地化的 selected 与 unselected Desktop 控件，再执行共享 Session 与 conversation 组件。

## Alternatives considered

**继续使用最近插入的 pairing。** 拒绝，因为插入顺序不代表用户意图，在恢复与修复中还可能变化，并会让 mutation 背后的 authority 含糊不清。

**Attach 每组 retained Desktop 并合并其 Session。** 拒绝，因为这会把独立 Session authority、cache、receipt 与 connection generation 合并成 Mobile Companion 禁止的新聚合状态模型。

**解除配对或连接失败后自动选择另一组 pairing。** 拒绝，因为 operation 必须指定一个 Paired Desktop。用户会显式选择下一个 authority，而不是继承由存储顺序或可用性决定的 fallback。

## Consequences

一个 Mobile Installation 可以保留并展示多台独立 Paired Desktop，同时只有一条 selected record 驱动其 Relay、Snow channel、cache 与 Session projection。选择与解除配对可能让产品保留 pairing 却没有 active Desktop，因此页面会保持 mutation unavailable，直到用户再次显式选择。

版本 2 刻意不提供预发布兼容 decoder。较旧的受保护 pairing 文档会显式失败，必须移除保留的受保护值并重新配对。Android 卸载会删除这份应用数据；iOS Keychain 可能在卸载后继续存在，因此仅重装应用不能可靠移除不兼容文档。
