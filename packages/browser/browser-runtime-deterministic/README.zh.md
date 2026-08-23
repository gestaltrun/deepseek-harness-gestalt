# @deepseek-ai/dsh-browser-runtime-deterministic

[English](README.md) | 中文

这是服务临时、命名持久与共享 Browser Profile 的确定性无密钥 Browser Runtime Provider。一个 Profile 可以拥有多个 Workspace、浏览器实例与标签页。它是可运行存储与 fixture 后端，不是操作系统浏览器。

## 配置

`idPrefix` 控制稳定的不透明 fixture 身份，默认值为 `browser-trace`。必填 `pages` 条目包含 `url`、`title`、`text` 与 `screenshotPngBase64`；截图数据必须是非空 canonical base64，且解码后的字节以 PNG signature 开头。空页面集合、重复 URL 与无效截图会让插件加载失败。

所有操作进入同一个串行队列。写操作要求所寻址 target 的当前修订号，读操作返回该修订号且不递增。Agent 合成 `input` 会应用 URL、文本或两者，并递增修订号。命名持久 Profile 通过稳定的 `persist:session-*` partition 恢复 cookie、localStorage、IndexedDB、cache 与 service worker 事实。共享 Profile 在 `persist:session-*-shared` 上恢复同样的事实，且不占用 `BROWSER_PROFILE_BUSY`。临时 Profile 获得唯一 partition、空存储，且没有地址栏标签。同一命名 Profile 的第二个打开写入方会以 `BROWSER_PROFILE_BUSY` 拒绝。释放开始后的操作会以 `BROWSER_DISPOSED` 拒绝。释放阶段停止接收新操作、排空已接受操作，并关闭每个仍打开的 Profile。

Provider state 是权威来源。其 invariant companion 在首次安装与热重载时从该状态建立基线，随后为身份、精确修订顺序与终态关闭注册同步 pre-commit validator。invariant 失败时，原 state 仍是权威来源。`browser/runtime-state` 是受容纳的提交后通知，因此损坏的普通 observer 不会让已提交操作表现为失败。

## 模型体验

通过 dsh-tool-browser 间接影响模型；该 Consumer 会渲染全部确定性页面与生命周期事实。

#### KV 缓存影响

Provider 自身不贡献请求文本；Consumer schema 与已记录结果决定缓存变化。

## 已知限制与后续工作

- 导航与合成输入 URL 只对配置的 fixture URL 成功；原生浏览器自动化仍不在本包中。
