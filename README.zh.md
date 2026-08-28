# DeepSeek Gestalt

[English](README.md) | 中文

<div align="center">
  <p><strong>DeepSeek Harness 的产品层。</strong></p>
  <p>
    <a href="https://www.gestaltrun.com/">网站</a> ·
    <a href="https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest">下载</a> ·
    <a href="docs/user/guide/index.zh.md">Web 指南</a> ·
    <a href="docs/architecture.zh.md">架构</a>
  </p>
</div>

DeepSeek Gestalt 正在 [DeepSeek Harness](https://www.deepseek.com/harness/)（`dsh`）之上构建完整的桌面端、Web 端与移动端产品。它以官方 DSH 的插件与运行时模型为基础，补齐产品工作流和发行能力，并通过经过测试的产品接口集成优秀社区插件。项目目标是稳定可用的产品发行，而不是补丁集合。

本项目持续合并 [DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)的改动，并尽可能把产品增量放在应用、Bundle、插件和有文档说明的能力 seam 上。DSH Profile、插件、CLI（命令行界面）模式和 SDK 入口是兼容性基线。Gestalt 目前仍处于开发者预览阶段，产品收敛过程中仍可能出现破坏兼容性的变更。

## 产品方向

- **补齐完整产品：** 增加 Desktop Host、Workbench、Mobile Companion、产品设置、发行打包、更新流程和验收路径，让 agent harness（智能体框架）成为可以日常安装和使用的软件。
- **保持 DSH 兼容：** 合并上游改动，保留 DSH 组合约定，不用另一套平台替换官方 agent loop（智能体循环）或插件模型。
- **集成社区成果：** 采用 [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 等有价值的插件，钉住经过审阅的修订，并让它们遵循 Gestalt 的生命周期、安全和展示规则。
- **交付一个连贯产品：** 让会话、工具、浏览器、文件、审批、Desktop 和 Mobile 共享同一份持久真源，而不是成为彼此割裂的应用。

## 产品功能地图

`DONE` 表示能力已合并进 `master`，但可能比最新打包版本更新。`DOING` 必须对应正在交付的 PR（Pull Request）。`TODO` 链接已确认的开放 Issue。短横线表示本地图在该状态下没有已经承诺的条目。

| 产品域 | DONE | DOING | TODO |
|---|---|---|---|
| Desktop 产品 | Electron Host、macOS 与 Windows 安装包、产品窗口框架、全屏 Settings、分阶段自动更新和会话日程（[#1](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/1)、[#26](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/26)、[#367](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/367)） | — | — |
| Workbench 与导航 | Better Sidebar 0.16.1、文件、多仓库 Git、Markdown/HTML、终端、自由窗口和由 agent 打开的 tab（[#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317)） | — | 简化 Workbench 内 Browser 的所有权（[#226](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/226)） |
| 会话工作流 | 持久 Side Chat、重启恢复、统一对话 UI、目标、fork、日程、后台工作和 subagent 图片提示词（[#247](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/247)、[#325](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/325)、[#329](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/329)） | — | — |
| 上下文与审阅 | 工作空间 `@file` 引用、目录下钻、上下文 dock、文本与图片 Annotation，以及按工作空间设置的工具准入（[#73](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/73)、[#80](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/80)、[#176](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/176)） | — | — |
| AI（人工智能）Browser | 会话所有的 Browser Profile、隔离工作空间、tab、Browser Dock、工具审批和重启恢复（[#104](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/104)、[#247](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/247)） | — | — |
| Mobile Companion | Platform Account、Personal Pairing、加密 Relay、由 Desktop 管理的会话浏览／搜索／历史、提示词、取消、审批、提问、附件、实时投影和多手机并发（[#312](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/312)、[#371](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/371)） | — | 受控的 iOS 与 Android 发行（[#44](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/44)） |
| 社区插件 | Better Sidebar 已作为经过审阅的源码快照集成；外部插件使用精确修订目录（[plugins](plugins/README.zh.md)、[#335](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/335)） | — | 可选 Sub2API 提供方、安装器和内嵌管理台（[#346](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/346)、[#348](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/348)、[#349](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/349)） |
| 跨账号协作 | — | Project Membership 与成员定向提问（[#338](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/338)、[#399](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/399)） | 发送方路由、接收体验和整体验收（[#343](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/343)、[#344](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/344)、[#345](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/345)） |
| 设备操作 | — | — | 侧栏手机 tab：启动 Android/iOS、显示实时画面、由人接手以及经过审批的 agent 工具（[#355](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/355)） |

## 功能导览

### Workbench 与社区侧边栏

Gestalt 用一个 Workbench 取代彼此割裂的面板。集成后的 Better Sidebar 提供文件与多仓库 Git 视图、渲染后的 Markdown 和 HTML、终端、自由窗口，以及可选的 `sidebar_open` 和终端工具。官方 Browser Runtime 使用原生 Workbench tab，而不是源码快照中的 iframe 后备实现。

| 侧边栏能力 | 产品行为 | 证据 |
|---|---|---|
| 文件与编辑器 | 浏览仓库文件、打开编辑器，并预览本地 HTML 与媒体 | [Better Sidebar](packages/client/ui-better-sidebar/README.zh.md) |
| 多仓库 Git | 在一个工作空间中选择并检查多个仓库的 Git 状态 | [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317) |
| 文档渲染 | 在侧边栏内渲染 Markdown、HTML、目录和图片 | [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317) |
| 终端 | 在对话旁保留终端 tab，并可选择向 agent 暴露终端工具 | [Better Sidebar](packages/client/ui-better-sidebar/README.zh.md) |
| 自由窗口 | 将支持的侧边栏内容拆进独立窗口 | [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317) |
| Browser | 将官方 Browser Runtime 页面放进带生命周期恢复的 Workbench tab | [Workbench 适配器](packages/client/ui-workbench/README.zh.md) |
| Side Chat | 使用统一对话 UI 运行持久子会话 | [#329](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/329) |
| 由 agent 打开的内容 | 让经过审批的 `sidebar_open` 调用聚焦本地文件、目录或网页 | [Better Sidebar](packages/client/ui-better-sidebar/README.zh.md) |

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/5ea5bae18c9083d1c200173ed8bb05e903fc3e1d/better-sidebar-v0.16.1-pr317-16311605.gif" alt="Gestalt Workbench 展示真实模型回复、仓库文件、Git 视图和 Better Sidebar 工具" width="900">
</p>

### 会话工作流

Side Chat 是持久子会话，使用与主会话相同的对话渲染器、模型选择、权限、日程、后台任务和后代导航。它们会在 Host 重启后恢复，并以事务方式归档。会话本地 Schedule 为 agent 创建的提醒提供持久暂停、恢复和删除操作。

<table>
  <thead>
    <tr>
      <th align="center">持久 Side Chat</th>
      <th align="center">会话日程</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3e32d89ee0e28a15cb099e6b90114601dfc537ce/issue-324-sidechat-restore-8469fa6eb8.gif" alt="Side Chat 在重启后恢复、继续，并在归档后保持关闭" width="520"></td>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/8be40575a41afeb231477bdf22ea0eb8976c7d71/issue-25-session-schedule-board.gif" alt="会话日程创建、暂停、恢复和删除提醒" width="520"></td>
    </tr>
  </tbody>
</table>

### 会话所有的 AI Browser

每个会话都会获得由持久 Browser Profile 支撑的隔离 Browser Workspace。Browser tab 位于 Workbench 中，可在 Runtime 重启后恢复最后一个非空 URL，并随所属会话的生命周期关闭。工具操作仍通过普通审批流水线。

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/849a04d76ae94c48a4d4b311942bbf1ca0f98888/pr/247/browser-lifecycle.gif" alt="会话所有的 Browser tab 完成导航、恢复并随生命周期关闭" width="900">
</p>

### 上下文与人工审阅

Workspace Reference 让人通过文件搜索、目录下钻、粘贴控制和 Composer dock 添加受限的 `@path` 上下文。Annotation 允许人选择 assistant 文本，或在暂存图片与历史图片上放置标记、附加说明、恢复草稿，并把结果作为普通的已记录用户消息提交。

<table>
  <thead>
    <tr>
      <th align="center">Workspace Reference</th>
      <th align="center">文本与图片 Annotation</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/a203adc7494cd5d8adae1fa23108afd98f7f022b/pr-164-workspace-reference-parity.gif" alt="Workspace Reference 选择器、目录下钻、Composer dock 和注入上下文" width="520"></td>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/7edaf7daa3d69b97382ef4b47ce35d37dce863b7/pr-70-text-annotation-517ad8.gif" alt="选择 assistant 文本、添加说明并提交 Annotation 草稿" width="520"></td>
    </tr>
  </tbody>
</table>

### Mobile Companion

Mobile Companion 不会创建另一套聊天后端。Desktop 仍是会话、工作空间、搜索、附件、审批和提问的权威；手机通过 Personal Pairing 和加密 Relay 访问这些能力。Desktop 与 Mobile 共用 Web 展示组件，使两端的对话行为保持一致。

<table>
  <thead>
    <tr>
      <th align="center">真实提供方会话续接</th>
      <th align="center">Desktop 配对与多手机并发</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3c711b7f0bc934d55f10dcdb9ee71e91850278f0/mobile-real-provider-98438f2.gif" alt="Mobile Companion 通过加密产品路径继续由 Desktop 管理的会话" width="260"></td>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/0af70c971b999cc54d18884233d7c59e595aba68/companion-ui-pr-371.gif" alt="Desktop Settings 同时显示两台已配对 Mobile 设备在线" width="620"></td>
    </tr>
  </tbody>
</table>

### Desktop 产品化与上游兼容

Gestalt 把 DSH Web 产品打包进 Electron Host，并提供官方 Node、仅 loopback 可访问的 Web server、产品窗口框架、原生 Browser Runtime、经过签名和公证的 macOS 构建、Windows 安装器、分阶段更新和退出所有权。仓库定期合并官方 DSH，通过文档、类型、快照、包、Electron 和平台门禁验证组合后的代码树，并通过固定精确修订的插件接入树外集成。

[架构文档](docs/architecture.zh.md)介绍共享插件树和能力 seam，[Desktop Host 参考](apps/desktop/README.zh.md)介绍打包与生命周期，[外部插件目录](plugins/README.zh.md)记录经过审阅的精确修订。

## 路线图

### DOING

- **Project 与成员定向提问：** [已确认的规格](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/338)增加跨账号 Project Membership、成员 roster 工具、Decision Brief 提问、有界文档传输和 peer Relay 凭据。[PR #399](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/399)正在功能基线上交付协议与凭据工作。

### TODO

- **完成成员提问：** 将 `ask_user_question` 路由到 Project Member，交付接收体验，并证明完整跨机器流程（[#343](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/343)、[#344](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/344)、[#345](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/345)）。
- **产品化 Sub2API：** 将已钉住的 sidecar 做成可选 Desktop 账号池提供方，并提供 Offer 卡、一键安装器和内嵌上游管理台（[#346](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/346)）。
- **从 Workbench 操作手机：** 增加 Android 和 iOS 手机 tab、实时画面与触控、设置指引和经过审批的设备工具（[#355](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/355)）。
- **完成受控 Mobile 发行：** 将验收绑定到候选版本，并发行经过批准的 iOS 与 Android 构建（[#44](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/44)）。

<a id="run"></a>

## 运行 Gestalt

### 桌面端

从 [GitHub Releases](https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest) 下载最新的 macOS 或 Windows 版本。

### Web 端

安装 [Node.js](https://nodejs.org/)，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会自动打开页面。进入 **Settings → Models** 添加模型提供方，选择工作空间，然后开始一个会话。[Web 指南](docs/user/guide/index.zh.md)介绍首次使用与 SSH 启动方式。

<a id="run-from-source"></a>

### 从源码运行

```sh
git clone https://github.com/gestaltrun/deepseek-harness-gestalt.git
cd deepseek-harness-gestalt
pnpm install
pnpm run build
pnpm dsh web
```

仓库开发流程见[开发指南](docs/development.zh.md)，面向 agent 的说明见 [AGENTS.md](AGENTS.md)。

## 社区与支持

- 通过 [GitHub Issues](https://github.com/gestaltrun/deepseek-harness-gestalt/issues) 报告 bug 或提交功能建议。
- 为插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于其他人发现。
- 添加企微小助手并填写问卷，即可加入 DeepSeek Harness 企微群。

<details>
  <summary>社区二维码</summary>
  <table>
    <thead>
      <tr>
        <th align="center">企微小助手</th>
        <th align="center">入群问卷</th>
        <th align="center">微信公众号</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
        <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
        <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
      </tr>
    </tbody>
  </table>
</details>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
