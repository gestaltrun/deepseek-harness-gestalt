# @deepseek-ai/dsh-browser-runtime-tandem

[English](README.md) | 中文

这是 Browser Runtime 能力的 Tandem 形态 HTTP Service Provider。它驱动 loopback HTTP API，操作包括 sessions、tabs、navigate、input、page-content、screenshot、focus 与 destroy，并通过 `ctx.browserRuntime` 暴露临时、命名持久与共享 Browser Profile。Tandem 是协议来源，不是 sidecar 二进制：生产环境的 Desktop 把该客户端指向进程内 Electron HTTP 适配器。出处记录见 [UPSTREAM.md](UPSTREAM.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；本包不 vendor 任何上游源码，也从不启动 Tandem.app。

## 配置

| 字段 | 含义 | 默认值 |
|---|---|---|
| `command` | 仅供 HTTP 协议测试使用的可选 fixture 可执行文件 | 省略 |
| `args` | 设置 `command` 时不经 shell 解释直接传递的参数 | `[]` |
| `cwd` | 作为可选 fixture 子进程工作目录的已存在目录 | 省略 |
| `env` | 叠加在 subprocess 服务已脱敏父环境之上的显式环境 | `{}` |
| `baseUrl` | loopback Tandem 形态 HTTP API origin，含其配置端口 | 必填 |
| `tokenFile` | HTTP 服务器写入其生成 API token 的本地文件 | 必填 |
| `idPrefix` | DSH 持有的不透明 Profile、Workspace 与浏览器身份前缀 | `tandem` |
| `startupTimeoutMs` | HTTP 健康验证的上限 | `60000` |
| `requestTimeoutMs` | 每次 Tandem 形态 HTTP 操作的上限 | `30000` |
| `healthPollMs` | 启动健康探测的间隔 | `250` |
| `pageSettleMs` | 单次内容读取允许上游页面稳定等待的上限 | `250` |
| `reconnectAttempts` | 意外退出后重启 fixture 子进程的次数 | `2` |
| `reconnectDelayMs` | 每次重连尝试前的延迟 | `500` |
| `processGraceMs` | fixture 释放时子进程树 SIGTERM 到 SIGKILL 的宽限 | `5000` |
| `maxResponseBytes` | 单个 Tandem 形态 HTTP 响应接受的最大字节数 | `10000000` |
| `sidecar` | 为 `false` 时在插件加载拒绝 `command`/`cwd`，且从不 spawn fixture 子进程 | `true` |

`baseUrl` 必须是绝对的 loopback HTTP origin（主机为 `127.0.0.1`、`localhost` 或 `[::1]`，不含凭据、路径、查询或 fragment），否则插件加载失败。`command` 与 `cwd` 要么同时设置以启动 HTTP fixture 子进程，要么同时省略以连接已有 loopback 服务器。`sidecar: false` 在配置了 `command` 或 `cwd` 时于插件加载失败；生产环境的 Desktop 设为 `false` 并省略二者。时长必须是正安全整数，`reconnectAttempts` 必须是非负安全整数。bearer token 从 `tokenFile` 读取，每次 HTTP 操作都携带它；启动健康检查在 `startupTimeoutMs` 内轮询 `GET /agent/version` 与 `GET /status`。页面读取发送 Provider 自有的 `settleMs`、`timeout` 与 `minLength` 查询上限。

所有操作进入同一个串行队列。写操作要求调用方提供最后观察到的 `expectedRevision`；读操作返回当前修订号且不递增。每个 Profile 映射到通过 `POST /sessions/create` 创建的一个 HTTP session。Agent 合成 `input` 调用 `POST /input`，携带客户端的 `expectedRevision`，并采纳引擎已提交的页面与修订号；不匹配时为 `BROWSER_REVISION_CONFLICT`。observe 与 page-content 采纳服务端修订号，使两侧持有同一把计数器。命名 Profile 恢复 `persist:session-*` partition；共享 Profile 恢复 `persist:session-*-shared` 且不占用 `BROWSER_PROFILE_BUSY`；临时 Profile 使用唯一的 `tmp-N` session 名与临时 `session-*` partition，且不留下可复用身份。同一命名 Profile 的第二个打开写入方会以 `BROWSER_PROFILE_BUSY` 拒绝。释放开始后的操作会以 `BROWSER_DISPOSED` 拒绝。释放阶段停止接收新操作、排空队列、无论是否存在 fixture 子进程都通过 `POST /sessions/destroy` 销毁剩余打开的 session，并在 `processGraceMs` 内 join 可选的 fixture 子进程。

fixture 子进程意外退出或健康检查失败会提交一个 reason 为 `crashed` 或 `unhealthy` 的 `BrowserUnavailableState`，其 `reconnecting` 由配置决定；存在 fixture 子进程时最多尝试 `reconnectAttempts` 次重启。恢复成功后以同一 target、下一修订号重新提交打开页面状态，重连耗尽则提交 `reason: 'reconnect-failed'` 且 `reconnecting: false`。该投影是真实的：不可用期间，针对该 target 的操作会以 `BROWSER_RUNTIME_UNAVAILABLE` 拒绝，而不是报告过期的页面事实。格式错误的 HTTP 响应、超限响应体与字段校验失败会以 `BROWSER_PROTOCOL` 拒绝。

## 模型体验

通过 dsh-tool-browser 间接影响模型；该 Consumer 会渲染全部页面、截图、生命周期与可用性事实。

#### KV 缓存影响

Provider 自身不贡献请求文本；Consumer schema 与已记录结果决定缓存变化。

## 已知限制与后续工作

- 生产环境的 Desktop 从不启动 Tandem.app。HTTP 客户端连接进程内 Electron 适配器；单元测试运行在仓库内 HTTP fixture 上。
- 上游贡献候选——隔离 session 的安全栈与扩展加载、可持久化的 session registry、close/forget/wipe 存储擦除、MCP 工具 allowlist/profile，以及一线 Linux 支持——列于 [UPSTREAM.md](UPSTREAM.md)。
