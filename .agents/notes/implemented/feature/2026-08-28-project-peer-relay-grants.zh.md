# Agent Note: 项目对等 Relay 授权签发按对端密封的 route 凭证

Status: implemented

[English](2026-08-28-project-peer-relay-grants.md) | 中文

## 问题

成员问答必须在不同 Platform 账号的 Desktop installation 之间端到端加密传输，但成员 installation 能获得的 route 权限此前只绑定 Personal Pairing，其授权链假设两端通过一次握手解析到同一账号。为成员 B 在成员 A 的 route 上签发凭证没有可用的缝：Relay route store 本就接受任意端点摘要，却没有面去证明 B 的项目成员资格、生成密封信封、持久化 grant，或在成员资格终止时将其写入撤销 tombstone。

## 决策

`remote-access` 在同一提供方上、与 Personal Pairing 并列新增 `projectPeerGrant` 面，通过 `PersonalPairingProviderOptions.projectPeerGrants` 组合注入（store、成员资格证明源、sealer）。成员资格证明源就是 Project Membership 能力自身的 `roster` 读取，经结构化的本地接口消费——该读取本就拒绝非成员读者，因此 grantor 与对端的成员资格都由一个既有操作证明，协议没有引入新的鉴权族或新的成员资格查询。

grantor 侧提供方生成规范的 P-256 Relay 凭证，只把它的 32 字节 SHA-256 公钥摘要按每个 grant 独立的 selector、在沿用的 route revision 上登记（`registerCredentialDigest` 只增加权限，不替换 route 的端点槽位），并持久化一条只持有摘要、来自组合 `ProjectPeerGrantSealer` 的密封信封与撤销状态的记录。sealer 是必需项：缺少组合 sealer 时该面失败关闭，密封信封是 Platform 存储与返回凭据的唯一形态。取回操作会重新证明读取者的成员资格，并先对项目内所有存活 grant 做对账——grantor 失去成员资格、对端失去成员资格或携带 route 消失的 grant，都会经由与显式撤销相同的补偿性摘要撤销进入撤销 tombstone；被打断的轮换也在这里修复其被取代的摘要。对同一对端 installation 重新授权即轮换：先登记替换摘要、再撤销被取代摘要，渠道因此不会降到零个有效凭证。

对端可见性需要一处 Relay 缝：`relayReady` 现在把无 selector 的 attachment 视为 route 所有者权限，同 revision 下带渠道 selector 的 attachment 也可见。grantor 自身 attachment 不带 selector，对端 attachment 带 grant selector，因此双向可见而不同 grant 相互隔离。既有 selector 配对行为不变，因为个人配对 route 只持有带 selector 的凭证，keyless route 只持有无 selector 的凭证。

## 已考虑的替代方案

**为对端引入新的 endpoint 类别。** 拒绝：`RelayAttachMessage.endpoint` 是封闭的两值协议联合，扩展它等于改动 wire 格式、所有 route store 与 attach 挑战 transcript，而它只是一个路由槽位，不是鉴权事实。

**经 `activateCredentialDigest` 轮换（整槽替换）。** 拒绝：`rotate` 会替换端点侧全部权限，在共享 route 上轮换一个 grant 会同时撤销个人配对的 Mobile 凭证与其他 grant。

**订阅 `project-membership/roster-invalidated` 做事件驱动撤销。** 本变更拒绝：订阅会把 remote-access 与 membership 包的事件契约耦合，而本票范围是签发机制与存储面。经注入 roster 读取的对账会在下一次 grant 面操作时以同样的 tombstone 结果撤销；移除时即刻撤销的生产接线归入下述注册表传输。

**平台签发明文凭证（端点化之前的签发流程）。** 拒绝：仓库已刻意移除 Platform 凭证签发；即使开发态面明文存储或返回 bearer 凭证，也会扩大端点流程本要约束的信任。

## 后果

本变更的交付止步于密封信封加持久记录：对端 installation 侧打开信封，以及承载它的跨机传输，都依赖尚不存在的项目注册表传输，因此成员问答只在 keyless controller 场景组装，生产级密封继续处于已记录的独立加密评审之后。撤销经 grant 面最终一致（任意 grant、取回、列表或撤销操作都会触发），而非与成员移除同步。规范凭证是完整 P-256 密钥、只持久化其 32 字节摘要，被签发的 grant 因此能走未改动的 attach 挑战流程；字面 32 字节秘密无法完成签名。`apps/platform` 的整包 face 带有与本次变更无关的 `pairing-state-codec.ts` 既有严格模式错误；受影响的消费方面（`remote-access-http`、`remote-access-client`、`remote-attachments`、`apps/mobile`）与 `remote-access` face 均编译通过。
