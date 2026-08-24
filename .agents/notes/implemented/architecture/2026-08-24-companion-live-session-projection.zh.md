# Agent Note：以有界替换投影实时 Session

状态：已实现

[English](2026-08-24-companion-live-session-projection.md) | 中文

## 问题

已鉴权的 Companion 产品可以加载由 Desktop 掌握权威的 Session，也能在 Mobile mutation 后刷新，但 agent 可以在没有后续 Mobile operation 时继续产生已经提交的输出。因此，已打开的 transcript 与隐藏 Session 列表会保持陈旧，直到手动刷新或重连。直接转发原始 Host event stream 会暴露进程本地 envelope，要求 Mobile 重建 Host projection，并引入无界 replay 与兼容性表面。

## 决策

Encrypted Companion Protocol major 4 新增 pairing-scoped `observe-session` operation 与主动发送的 `session-live` 替换。每个已鉴权 Mobile attachment 最多观察一个已打开 Session。Desktop 会为每个变化的 Session 读取当前权威 Host Session 列表与 Workspace 列表，并且只在该 Session 对此 pairing 已打开时读取有界 Session history。隐藏 Session 的替换只包含摘要、从零开始的位置与 Workspace 归属。权威列表中缺失的 Session 会产生显式移除。协议永不转发原始 Host event 或隐藏 transcript。

存在已鉴权 Mobile 连接时，Desktop 会租用当前 loopback Host 的 mux 与 Session WebSocket stream。第一个连接打开两条 stream，最后一个连接中止它们；Host 替换会先中止当前两条 stream，再安装其后继。权威 Session event 会触发单 Session projection。Workspace 创建、更新、移除、重排与归档 event 会触发 foreground synchronization 及其后的完整分页 baseline。baseline 会过滤 `archivedSessionIds`；其 cursor 通过 pairing、physical generation、epoch 与 offset 标识一份冻结的 Session 和 Workspace snapshot，而不依赖每次发送时分配的 Desktop revision。模型可见的 `assistant/chunk` 文本只会在已经存在于持久 Session history 后读取。重新读取 history 使模型可见输出仍能从 Session log 重建，而不会把 transport frame 当作权威。stream 关闭、无效 Host 数据、projection 失败或队列超限都会淘汰受影响的已鉴权 channel，并要求现有 Relay lifecycle 重连。

一个 pairing-scoped source 按 Session 合并重复变化。每次 observation 变更都会推进 epoch。projection 在 Host 读取结束后及 Snow 密封前立即重新校验该 epoch；过期的详细结果会变成仅含摘要的结果。每个 attachment 有一个最多包含 32 个不同 Session 的有界队列，以及一条与 operation result 和 foreground synchronization 共用的串行 Snow sender。Desktop revision 在加密发送时分配，即使失败发送留下空洞也保持单调。conversation 超出完整 projection 的 48 KiB 上限时，会先丢弃最旧 node；如果最新 node 本身仍然过大，其展示文本会在 UTF-8 边界截断到可编码的最大前缀。Mobile 只接受属于当前 physical generation 且 revision 严格更高的实时替换。它会忽略重复项，以原子方式替换一个 Session，并且在分页 baseline 尚未完成时最多排队 32 个不同 Session。完成的 baseline 会删除权威列表中不存在的 Session conversation。新的 generation 总是从 foreground synchronization 与完整权威 baseline 开始；transport event 不会重放。

打开或关闭 Mobile Session 视图会发送 observation 变更。断开时可以继续展示此前已鉴权内容，但 observation 不会跨越 attachment replacement。断连、进入后台、移除配对、Host 替换或关闭会先清除 observer、pending projection work、WebSocket listener 与 abort controller，再释放自有 channel。关闭过程会排空已经启动的有序发送，但不再接收新工作。

## 验证

协议测试固定 major 协商、严格的 `observe-session` 与 `session-live` codec、旧 major 拒绝、限制、移除字段与 revision 字段。Desktop 与 Mobile 单元测试固定已打开与隐藏 projection、observation 切换和关闭竞态、stream 租约、合并、单个超大 entry、累计 transcript 尾部、generation 替换、teardown、重复 revision、有界 baseline 合并与共享组件 observation lifecycle。组装测试启动真实 Host Session persistence 和 HTTP/WebSocket stream，建立生产 Snow owner，在发送 revision 变化期间分页超过 20 个 Session，追加已经记录的 assistant chunk，并在 Mobile 共享组件中观察真实 Workspace 创建、重排、移除与 Session 归档。无密钥的 Mobile build-and-preview 捆绑快照会在 5173 和 5174 之外的端口展示同一可见变化。

## 考虑过的替代方案

**按可见时间间隔轮询或刷新。** 不采用，因为它会增加空闲流量，并且两次轮询之间仍存在无界陈旧区间。

**转发原始 Host event。** 不采用，因为 Host event 不是 Mobile 展示协议，隐藏 Session 不得接收 transcript 字节，而且 transport delivery 不是应用权威。

**发送每个完整 transcript。** 不采用，因为隐藏 Session 只需要有界列表状态，而持续增长的 transcript 会消耗交互 channel 的固定应用上限。

**持久化并重放实时 transport frame。** 不采用，因为持久 Session history 已经拥有输出。重连会取得新的权威 baseline，revision 则提供 connection-local 幂等性。

## 后果

已鉴权且处于前台的 Mobile 视图会跟随已经记录的 Desktop 输出，无需手动刷新；隐藏 Session 列表也会跟随有界权威摘要。该机制刻意不提供后台通知投递，也不会在 Mobile 进入后台后维持连接。Host 或 projection 失败会暂时以可用性换取显式 channel 重连与完整重新同步。Companion major 3 仍是紧邻的安全前一版本，但不能使用实时 projection。
