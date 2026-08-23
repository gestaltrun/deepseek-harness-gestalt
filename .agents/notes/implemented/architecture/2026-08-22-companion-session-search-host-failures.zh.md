# Agent Note: 通过 Companion 投影权威 Session 搜索与 Host 失败

Status: implemented

[English](2026-08-22-companion-session-search-host-failures.md) | 中文

## 问题

Mobile Companion 需要查找只存在于 Paired Desktop 索引中的 Session 内容，并且每次 Host 拒绝在穿过加密应用 channel 后都必须保持可见。搜索 Companion Cache 会让 Mobile 成为第二个 Session 权威，并漏掉冷内容。把非 2xx 响应、格式错误的 JSON、业务拒绝或超时当作抛出的 transport error，可能会让 HTTP 400 坍缩成空对象或无声 stream loss。

## 决策

Desktop 专用 composition 以 `openAt: first-search` 激活 `session-query-sqlite`，并把派生索引放在 `DSH_HOME/session-search.sqlite`；浏览器 `dsh web` 仍使用仓库默认的 `openAt: never`。Companion 的 `search-sessions` operation 调用 Web Host 的 `session.search` 方法。Mobile 会直接渲染每个关联的 `session-search` Session id/snippet 对，包括 Companion Cache 中不存在的命中，并且绝不会加入缓存中的标题、Workspace、摘要、transcript 或子串匹配。

Encrypted Companion Protocol 以 `operation-failed` 作为无损 Host 失败 result。它的闭合类别包括 HTTP 状态、无效 wire response、类型化业务错误和超时。HTTP 失败保留包括 400 在内的数值状态；业务失败保留有界 code 与 message；每个失败都携带发起 operation id。Desktop loopback client 会在非 2xx response header 到达时立即结算，使 response body 累计与绝对墙钟 deadline 都不能替换已知状态。它会校验成功 RPC 的 envelope 与回显 id；其可配置 response accumulator 不能超过 60 KiB Companion 应用 message 上限，累计超限会销毁 response，并产生无效 wire failure。这些预期失败会作为值返回，而不是抛出。Mobile surface 只通过绑定到 decoder 物理连接 generation 的 receiver 接受 result。它会把搜索 result 与当前搜索 operation 关联，并且只拥有 mutation channel 返回的一个尚未结算的 attachment operation id。sending 或 uncertain attachment 会阻止再次选择文件，直到确认、拒绝、失败或对账 status 释放该 id；其他 attachment id 的所有 result 都不会生效。attachment send completion 可以发布保留该 id 以便对账的 uncertain 状态。搜索与 attachment 失败会成为可见 alert；断开、替换或进入后台会让旧 decoder receiver 失效。

Desktop Host 会在发布的 Web Host 报告 loopback origin 后安装 `DesktopCompanionProductOwner`，在 Web Host 重启时替换该 RPC，并在关闭前移除。Desktop 入口 smoke 会创建真实 Session 并提交 prompt，再通过这个已安装 owner 要求一次索引命中与一次无命中的 `session.search`。源码平面的 Host composition 会组合真实 Session event、SQLite provider、Host API carrier、loopback HTTP 与 Desktop owner，且不要求 Web client build artifact；它覆盖索引命中、无命中、已关闭和故障 provider。有界跨进程组装会把真实 HTTP 400 经 Desktop owner 与 Companion codec 送到发布 Mobile 入口的 alert。这些证据只证明发布 endpoint composition 与应用投影；经过评审的加密 channel 仍拥有 endpoint operation 交付与配对范围 attachment 依赖。

搜索结果最多包含 20 个唯一 Session id，每个 snippet 最多包含 240 个 Unicode code point。查询沿用 Host 的 500 个 UTF-16 code unit 上限。失败消息限制为 4,096 个 UTF-8 字节。协议 codec 与 Desktop adapter 会独立执行这些上限，使有效 Host 响应无法变成超限的 Encrypted Companion 消息。

该决策实现[真实 Companion 产品链路](../../proposed/architecture/2026-08-22-real-companion-product-path.md)中的 Session 搜索与 Host 失败切片。[配对范围的附件决策](../feature/2026-08-19-encrypted-companion-attachments.md)负责附件密文与字节交付；本记录负责 Host 结局如何穿过 Companion 应用协议。

## 曾考虑的替代方案

**先在 Companion Cache 本地过滤，只向 Desktop 查询缺失结果。** 拒绝，因为本地子串规则不同于 SQLite provider，会漏掉未打开或冷 Session，并让合并排序取决于 Mobile 缓存历史。

**把每种 Host 失败都映射成一个 `host-rejected` 原因。** 拒绝，因为用户无法区分格式错误的请求、已关闭或故障的索引、损坏的 Host 响应与截止时间；这种做法还会丢弃诊断 carrier 失败所需的 HTTP 状态。

**透传完整 Host response envelope。** 拒绝，因为完整 Host API 不属于 Companion Surface authority，并且会让独立发布的 Mobile 版本耦合 Host RPC 字段。Companion 只投影有界搜索值与稳定失败。

**在共用 Web bundle 中启用全文搜索。** 拒绝，因为内容索引是一项部署选择。Desktop 产品为了 Companion 需要启用它，而浏览器与 headless 部署仍保留默认关闭策略。

## 后果

Mobile 搜索质量、可见性与 snippet 来自与 Web Session 搜索相同的 Desktop 权威，并且不要求存在匹配的缓存 Session。attachment 拒绝、attachment Host 失败与 uncertain delivery 会保持关联且可见。Host 400、格式错误的响应、业务拒绝、绝对 deadline 超时或陈旧 decoder result 会保持显式或失效，而不会消失或修改替换后的状态。Desktop 会承担派生索引存储与首次搜索启动成本；浏览器 `dsh web` 不承担。经过评审的加密 channel 仍负责安装 Mobile operation 发送方与按 generation 绑定的解码 result receiver，因此发布的 endpoint、协议与 adapter 证据本身不能证明运营中的产品链路。
