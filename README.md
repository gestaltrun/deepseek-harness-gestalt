# Gestalt

English | [中文](README.zh.md)

<div align="center">
  <img src="docs/assets/brand/tazige-ip.png" alt="Tazige, the otter IP character for Gestalt" width="560">
  <p><sub>Product name: Gestalt · Chinese name and IP character: 獭子哥</sub></p>
  <p><strong>Gestalt is the product layer for DeepSeek Harness.</strong></p>
  <p>
    <a href="https://www.gestaltrun.com/">Website</a> ·
    <a href="https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest">Download</a> ·
    <a href="docs/user/guide/index.md">Web guide</a> ·
    <a href="docs/architecture.md">Architecture</a>
  </p>
</div>

Gestalt is building a complete desktop, web, and mobile product on top of [DeepSeek Harness](https://www.deepseek.com/harness/) (`dsh`). Its Chinese product name and IP character are **獭子哥**. Gestalt keeps the official DSH plugin and runtime model as its base, fills in product workflows and distribution, and integrates strong community plugins behind tested product interfaces. The goal is a stable, usable product distribution rather than a collection of patches.

The project continuously merges the [official DSH repository](https://github.com/deepseek-ai/deepseek-harness) and keeps product additions on apps, bundles, plugins, and documented capability seams wherever possible. DSH profiles, plugins, CLI modes, and SDK entry points remain the compatibility baseline. Gestalt is still in developer preview, so compatibility-breaking changes remain possible while the product converges.

## Product direction

- **Complete the product:** add the Desktop Host, Workbench, Mobile Companion, product settings, release packaging, update flow, and acceptance paths that turn the harness into software people can install and use every day.
- **Keep DSH compatible:** merge upstream changes, preserve DSH composition contracts, and avoid replacing the official agent loop or plugin model with a separate platform.
- **Integrate community work:** adopt useful plugins such as [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), pin reviewed revisions, and adapt them to Gestalt lifecycle, security, and presentation rules.
- **Ship one coherent product:** make Sessions, tools, browsers, files, approvals, Desktop, and Mobile share one durable source of truth instead of becoming disconnected applications.

## Product map

`DONE` means the capability is merged into `master`; it may be newer than the latest packaged release. `DOING` requires an active delivery pull request. `TODO` links an accepted open issue. A dash means this map has no committed item for that state.

| Product area | DONE | DOING | TODO |
|---|---|---|---|
| Desktop product | Electron Host, macOS and Windows packages, product chrome, fullscreen Settings, staged auto-update, and Session Schedule ([#1](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/1), [#26](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/26), [#367](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/367)) | — | — |
| Workbench and navigation | Better Sidebar 0.16.1, files, multi-repository Git, Markdown/HTML, terminals, free windows, and agent-opened tabs ([#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317)) | — | Simplify Browser ownership inside the Workbench ([#226](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/226)) |
| Session workflows | Durable Side Chats with restart restoration and canonical conversation UI, the Gestalt Schedule board, and image prompts for capable subagent providers ([#26](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/26), [#247](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/247), [#325](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/325), [#329](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/329)) | — | — |
| Context and review | Workspace `@file` references, folder descent, context dock, text and image annotations, and per-Workspace tool eligibility ([#73](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/73), [#80](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/80), [#176](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/176)) | — | — |
| AI Browser | Session-owned Browser Workspaces and tabs, shared/temporary/named persistent Profiles, Browser Dock, tool approvals, and restart recovery ([#104](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/104), [#247](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/247)) | — | — |
| Mobile Companion | Platform Account, Personal Pairing, encrypted Relay, Desktop-owned Session browse/search/history, prompts, cancellation, approvals, questions, attachments, live projection, concurrent phones, TestFlight delivery, and a signed Android APK ([#312](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/312), [#371](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/371), [#398](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/398), [#44](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/44)) | — | — |
| Community plugins | Better Sidebar is integrated as a reviewed source snapshot; external plugins have an exact-revision catalog ([plugins](plugins/README.md), [#335](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/335)) | — | Optional Sub2API provider, installer, and embedded management console ([#346](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/346), [#348](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/348), [#349](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/349)) |
| Cross-account collaboration | — | Project membership and member-directed questions ([#338](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/338), [#399](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/399)) | Sender routing, receiver experience, and assembled acceptance ([#343](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/343), [#344](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/344), [#345](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/345)) |
| Device operation | — | — | Sidebar phone tabs for Android/iOS launch, live view, human takeover, and approved agent tools ([#355](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/355)) |

## Feature tours

### Workbench and community sidebar

Gestalt replaces a collection of disconnected panels with one Workbench. The integrated Better Sidebar provides file and multi-repository Git views, rendered Markdown and HTML, terminals, free windows, and optional `sidebar_open` and terminal tools. The official Browser Runtime occupies native Workbench tabs instead of the snapshot's iframe fallback.

| Sidebar capability | Product behavior | Evidence |
|---|---|---|
| Files and editors | Navigate repository files, open editors, and preview local HTML and media | [Better Sidebar](packages/client/ui-better-sidebar/README.md) |
| Multi-repository Git | Select and inspect Git state across repositories in one workspace | [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317) |
| Rendered documents | Render Markdown, HTML, tables of contents, and images inside the sidebar | [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317) |
| Terminal | Keep terminal tabs beside the conversation and optionally expose terminal tools to the agent | [Better Sidebar](packages/client/ui-better-sidebar/README.md) |
| Free windows | Detach supported sidebar content into independent windows | [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317) |
| Browser | Place official Browser Runtime pages in Workbench tabs with lifecycle recovery | [Workbench adapter](packages/client/ui-workbench/README.md) |
| Side Chat | Run a durable child Session with the canonical conversation UI | [#329](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/329) |
| Agent-opened content | Let an approved `sidebar_open` call focus a local file, folder, or web page | [Better Sidebar](packages/client/ui-better-sidebar/README.md) |

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/5ea5bae18c9083d1c200173ed8bb05e903fc3e1d/better-sidebar-v0.16.1-pr317-16311605.gif" alt="Gestalt Workbench showing a real model response, repository files, Git views, and Better Sidebar tools" width="900">
</p>

### Session workflows

Side Chats are durable child Sessions with the same conversation renderer, model selection, permissions, schedules, jobs, and descendant navigation as the main Session. They restore after a Host restart and archive transactionally. Session-local Schedule adds durable pause, resume, and delete controls for reminders created by the agent.

<table>
  <thead>
    <tr>
      <th align="center">Durable Side Chat</th>
      <th align="center">Session Schedule</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3e32d89ee0e28a15cb099e6b90114601dfc537ce/issue-324-sidechat-restore-8469fa6eb8.gif" alt="Side Chat restoring after restart, continuing, and staying closed after archive" width="520"></td>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/8be40575a41afeb231477bdf22ea0eb8976c7d71/issue-25-session-schedule-board.gif" alt="Session Schedule creating, pausing, resuming, and deleting a reminder" width="520"></td>
    </tr>
  </tbody>
</table>

### Session-owned AI Browser

A Session can own zero or more Browser Workspaces and tabs. Each Workspace uses a shared, temporary, or named persistent Browser Profile; the default shared Profile reuses storage across Sessions and is not an isolation guarantee. Browser tabs live in the Workbench, recover their last non-blank URL after Runtime restarts, and close with their owning Session lifecycle. Tool actions pass through the ordinary approval pipeline.

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/849a04d76ae94c48a4d4b311942bbf1ca0f98888/pr/247/browser-lifecycle.gif" alt="Session-owned Browser tab navigating, recovering, and closing with its lifecycle" width="900">
</p>

### Context and human review

Workspace References let a person add confined `@path` context through file search, folder descent, paste controls, and a Composer dock. Annotation lets a person select assistant text or pin staged and historical images, attach notes, recover the draft, and submit the result as an ordinary logged user message.

<table>
  <thead>
    <tr>
      <th align="center">Workspace Reference</th>
      <th align="center">Text and image Annotation</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/a203adc7494cd5d8adae1fa23108afd98f7f022b/pr-164-workspace-reference-parity.gif" alt="Workspace Reference picker, folder descent, Composer dock, and injected context" width="520"></td>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/7edaf7daa3d69b97382ef4b47ce35d37dce863b7/pr-70-text-annotation-517ad8.gif" alt="Selecting assistant text, adding a note, and submitting the Annotation draft" width="520"></td>
    </tr>
  </tbody>
</table>

### Mobile Companion

Mobile Companion does not create a separate chat backend. Desktop remains the authority for Sessions, Workspaces, search, attachments, approvals, and questions; the phone reaches that authority through Personal Pairing and an encrypted Relay. Shared Web presentation components keep conversation behavior aligned across Desktop and Mobile.

<table>
  <thead>
    <tr>
      <th align="center">Real-provider Session continuation</th>
      <th align="center">Desktop pairing and concurrent phones</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3c711b7f0bc934d55f10dcdb9ee71e91850278f0/mobile-real-provider-98438f2.gif" alt="Mobile Companion continuing a Desktop-owned Session through the encrypted product path" width="260"></td>
      <td align="center"><img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/0af70c971b999cc54d18884233d7c59e595aba68/companion-ui-pr-371.gif" alt="Desktop Settings showing two paired Mobile devices online at the same time" width="620"></td>
    </tr>
  </tbody>
</table>

### Desktop productization and upstream compatibility

Gestalt packages the DSH Web product inside an Electron Host with official Node, a loopback-only Web server, product window chrome, native Browser Runtime, signed and notarized macOS builds, Windows installers, staged updates, and shutdown ownership. The repository periodically merges official DSH, runs the combined tree through documentation, type, snapshot, package, Electron, and platform gates, and keeps out-of-tree integrations behind pinned plugin revisions.

Read the [architecture](docs/architecture.md) for the shared plugin tree and capability seams, the [Desktop Host reference](apps/desktop/README.md) for packaging and lifecycle, and the [external plugin catalog](plugins/README.md) for reviewed revision pins.

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
