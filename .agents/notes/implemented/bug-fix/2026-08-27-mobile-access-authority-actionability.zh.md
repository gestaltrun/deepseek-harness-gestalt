# Agent Note：保持 Mobile Access Authority 可操作

Status: implemented

[English](2026-08-27-mobile-access-authority-actionability.md) | 中文

## 问题

Desktop Relay 启动会在持有 lifecycle authority 串行区时等待物理 WSS 就绪，因此 attachment 不可用时，Settings 轮询与新配对挑战都会被阻塞。成功关闭功能后，本地仍保留 Platform 已撤销的 grant。Mobile 重复项清理进入了一条会对同一个一次性 Installation proof 鉴别两次的撤销路径。实际运行的 Relay 没有接入 PostgreSQL pairing activity sink，因此 Mobile channel 已工作时，Desktop Settings 仍显示离线。

## 决策

Desktop lifecycle authority 会在串行区内启动每个所需的物理 controller，释放 authority 串行区后才等待网络就绪。成功关闭 Mobile Access 后，只在 Platform 提交关闭状态后清除本地 active 与 pending grant。Pairing revocation 只鉴别一次，并在 cleanup transaction 中复用已解析的 Account 与 Installation id。撤销不存在的 Mobile authority 与取消不存在的 endpoint challenge 都是幂等操作。实际运行的 Relay 会把共享 PostgreSQL Personal Pairing authority 作为 Mobile presence sink。

## 考虑过的替代方案

**持有 authority 串行区直至 WSS 就绪。** 拒绝，因为网络可用性会继续控制 Settings 能否创建、取消或关闭 pairing authority。

**在 Platform 关闭前清除本地 grant。** 拒绝，因为远端提交失败时会留下有效 authority，却失去本地 cleanup identity。

**根据 Desktop socket 投影在线状态。** 拒绝，因为 Mobile presence 来自已鉴别 lease，并且可以通过任一 Platform instance attach。

**在客户端重试 `PROOF_REPLAYED`。** 拒绝，因为服务端在同一个请求中消费了两次 proof；重试会隐藏该 ownership 错误，并再次尝试 mutation。

## 后果

Relay attachment 不可用时，Settings 同步、挑战创建与关闭功能仍然可操作。重新开启 Mobile Access 不会恢复 Platform 已撤销但本地残留的 authority。任一已鉴别 Mobile attachment 都会跨两个 Platform instance 更新由持久 lease 推导的在线状态；中断或已经完成的 cleanup 可以通过重试收敛。

## 测试

Lifecycle coverage 会让物理启动保持 pending，同时证明 authority 同步可以完成。Desktop controller coverage 证明关闭再开启不会恢复过期 grant。Provider coverage 证明 endpoint cancellation 可重复执行，且 Mobile revocation 只调用一次 Account authentication。实际运行组合 coverage 要求接入 PostgreSQL pairing activity sink。
