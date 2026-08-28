# DeepSeek Gestalt

English | [中文](README.zh.md)

<div align="center">
  <p><strong>A durable workspace for agents and the people directing them.</strong></p>
  <p>
    <a href="https://www.gestaltrun.com/">Website</a> ·
    <a href="https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest">Download</a> ·
    <a href="docs/user/guide/index.md">Web guide</a> ·
    <a href="docs/architecture.md">Architecture</a>
  </p>
</div>

DeepSeek Gestalt is a desktop, web, and mobile workspace built on [DeepSeek Harness](https://www.deepseek.com/harness/) (`dsh`). It keeps coding work in durable Sessions that you can inspect, resume, split into focused Side Chats, and continue from a paired phone.

DeepSeek Harness is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com). It runs on [Cordis](https://github.com/cordiverse/cordis) and follows one rule throughout the system: **everything is a plugin**.

## Vision

Agent work should survive a prompt, a window, and a device. Gestalt is building one continuous workspace where models, tools, files, approvals, and clients share a durable Session instead of relying on hidden chat state.

Every model-visible input is recorded in the Session log. Human decisions remain explicit. Capabilities such as models, tools, sandboxes, browsers, subagents, persistence, and clients can be replaced or extended without patching a privileged core.

## See it working

### Work with the repository in view

The Workbench keeps conversations, files, repositories, terminals, and free windows together. Better Sidebar adds Markdown rendering, multi-repository Git views, file navigation, and agent-operated sidebar actions.

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/5ea5bae18c9083d1c200173ed8bb05e903fc3e1d/better-sidebar-v0.16.1-pr317-16311605.gif" alt="DeepSeek Gestalt Workbench showing a real model response and Better Sidebar repository tools" width="900">
</p>

### Split off focused work and return later

Side Chats are real child Sessions, not temporary panels. Published Side Chats retain their history and model route, restore after a Host restart, and archive when closed.

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3e32d89ee0e28a15cb099e6b90114601dfc537ce/issue-324-sidechat-restore-8469fa6eb8.gif" alt="A Side Chat restoring after restart, continuing with its original model route, and staying closed after archive" width="900">
</p>

### Continue the same Session on a phone

Mobile Companion pairs with Desktop through the operated Platform and encrypted Relay. The phone browses Desktop-owned Sessions, renders their conversation, settles pending interactions, and submits work without creating a second source of truth.

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3c711b7f0bc934d55f10dcdb9ee71e91850278f0/mobile-real-provider-98438f2.gif" alt="Mobile Companion continuing a Desktop-owned Session through the encrypted product path" width="360">
</p>

## What is built today

- **Durable Sessions:** append-only events reconstruct model history, tool trajectories, replay, forks, and client projections; persisted Sessions also support search.
- **Agent workspace:** file editing, shell and terminal execution, LSP, browser control, web search, plans, goals, background jobs, and continuable subagents compose through plugins.
- **Human control:** approvals, questions, tool eligibility, settings, and credential references stay outside the model's authority.
- **Multiple clients:** the browser UI, Desktop Host, encrypted Mobile Companion, CLI, ACP server, JSON-RPC client, and TypeScript and Python SDKs project the same agent loop for their use cases.
- **Replaceable capabilities:** profiles and bundles select model providers, tools, storage, sandboxes, policies, and UI contributions from configuration.

Read the [architecture](docs/architecture.md) for the plugin tree, Session lifecycle, and capability seams. The generated [tool catalog](docs/tool-catalog.md) and [configuration catalog](docs/config-catalog.md) describe the current runtime interfaces.

<a id="run"></a>

## Run Gestalt

### Desktop

Download the latest macOS or Windows build from [GitHub Releases](https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest).

### Web

Install [Node.js](https://nodejs.org/), then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` and opens it for a local launch. Open **Settings → Models**, add a provider, choose a workspace, and start a Session. The [Web guide](docs/user/guide/index.md) covers the first run and SSH launches.

<a id="run-from-source"></a>

### From source

```sh
git clone https://github.com/gestaltrun/deepseek-harness-gestalt.git
cd deepseek-harness-gestalt
pnpm install
pnpm run build
pnpm dsh web
```

Use the [development guide](docs/development.md) for repository workflows and [AGENTS.md](AGENTS.md) for agent instructions.

## Status

DeepSeek Harness is in developer preview. Releases may contain compatibility-breaking changes.

## Community and support

- Report bugs and request features through [GitHub Issues](https://github.com/gestaltrun/deepseek-harness-gestalt/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to a plugin repository so others can find it.
- Join the DeepSeek Harness WeCom group by adding the assistant and completing the survey.

<details>
  <summary>Community QR codes</summary>
  <table>
    <thead>
      <tr>
        <th align="center">WeCom assistant</th>
        <th align="center">Group survey</th>
        <th align="center">WeChat official account</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness WeCom assistant QR code" width="180" height="180"></td>
        <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness group survey QR code" width="180" height="180"></a></td>
        <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness WeChat official account QR code" width="180" height="180"></td>
      </tr>
    </tbody>
  </table>
</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
