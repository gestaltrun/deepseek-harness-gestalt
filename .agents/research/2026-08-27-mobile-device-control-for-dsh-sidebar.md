# Mobile device control for DSH (agent tools + viewing pane)

Date checked: 2026-08-27 (Asia/Shanghai, 14:48–15:00 CST)

检索口径：本地 `/Users/yishu.cy/IdeaProjects/deepseek-harness`（sidebar / details / MCP / capability-seam 一手源）；GitHub REST API `api.github.com` + `raw.githubusercontent.com`（本机无 `gh`，未用 Search API code 端，因其要求认证）。检索时刻的 star / pushed_at 来自 REST `GET /repos/:owner/:repo` 与 `GET /search/repositories`。`topic:dsh-plugin` 噪声极大，**不能把 topic 或 star 当成 DSH 插件证据**；下文只收录核对过 README / `package.json`（`dsh.bundle` / `dsh.client`）/ 工具名 / 客户端 slot 注册的仓库。

用户目标：在 Web GUI 里做一个**手机端控制/查看**能力，类似 ego-lite 浏览器那种 agent 友好基础设施——agent 可调工具 + 人能看见/接手画面。范围包括 ADB 安卓真机、Android 虚拟机、iOS。这**不是** Mobile Companion（人用手机遥控 Desktop 上的 DSH Session）；后者已被 [proposed Mobile Companion note](../notes/proposed/feature/2026-08-17-mobile-companion.md) 明确拆开。

## 1. Recommendation

**不要从零做。先装 [ZSeven-W/dsh-android](https://github.com/ZSeven-W/dsh-android)（安卓）和可选的孪生仓 [ZSeven-W/dsh-ios](https://github.com/ZSeven-W/dsh-ios)（iOS）。** 它们已经是 ego-lite 在手机上的对应物：agent 工具 + 人可见的右侧 live 面板 + 人可在画面上点/拖接手。不要占左侧 `sidebar` 槽。

| 问题 | 结论 |
|---|---|
| 有没有现成 dsh-plugin？ | **有。** `@zseven-w/dsh-android` v0.1.0-rc.4（20 个 `android_*` 工具，进程内 `adb exec-out screencap` PNG 流，右侧 dock）和 `@zseven-w/dsh-ios` v0.1.0-rc.5（22 个 `ios_sim_*` 工具，serve-sim MJPEG + 真机 WDA）。都声明 `dsh.bundle` + `dsh.client`，安装命令就是 `dsh plugin --profile web add @zseven-w/dsh-android@latest`。 |
| 要不要占左侧 sidebar？ | **不要。** `sidebar` 是单槽，注册它会整列替换工作区导航（[`packages/client/ui-sidebar/src/client/contract/slots.ts`](../../packages/client/ui-sidebar/src/client/contract/slots.ts)）。dsh-android 自己也把 live 画面放在**右侧 page-owned dock**，并注释这是 Codex-style；当前 DSH 未声明 `tool.details.toolview`，所以它不走官方 details 列。 |
| 和 ego-lite 怎么对齐？ | ego-lite（[citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)，★13858，MIT）= 独立 Chromium + Task Space 隔离 + `ego-browser` JS helper + 人可接管。手机侧的同一拆分已经存在：工具（tap/swipe/type/ui-tree/OCR）vs 观看（signed `/_dsh/dsh-android/*` 流）vs 接手（面板上点/拖）。浏览器侧 DSH 插件是 [Fisfzy/dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)（npm `@dsh-external/ego-browser`，32 个 `ego_*` + 观察窗），**不是**手机方案。 |
| 若只要工具、不要 GUI？ | 用已有 [`@deepseek-ai/dsh-mcp-client`](../../packages/mcp/mcp-client/README.md) 接 [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp)（★6037，Apache-2.0，iOS+Android 同一套 `mobile_*` 工具）。这给不出 live 面板。 |
| 若要做一等公民能力缝？ | 等验证完 dsh-android 的产品缺口再开。模板是 bash 三件套（Service Definition / Provider / Consumer）+ Tandem 式外部进程。**不要**把 MCP 的几十个工具直接当 DSH 工具词表（Browser Runtime 对 Tandem 257-tool MCP 已拒绝过同样的事）。 |
| 和 Mobile Companion？ | 禁止合并。Companion 是人在手机上看 Desktop Session；本需求是 agent 在 Desktop 上控一部手机/模拟器。 |

一句话产品路径：

1. `dsh plugin --profile web add @zseven-w/dsh-android@latest`，接 USB 调试真机或 AVD，让 agent 跑 `android_devices` → `android_boot`，人在右侧面板看流。
2. macOS + Xcode 再加 `@zseven-w/dsh-ios`。真机要自己准备 WebDriverAgent checkout（插件不下载）。
3. 帧率不够时，沿 dsh-android 自己的 roadmap 换成 `scrcpy-server` + WebCodecs，而不是另起一个 MCP sidecar。
4. 只有在「我们要官方 `ctx.device`、审批语义、多设备农场」时才做一等公民缝；那时仍复用 dsh-android 的 signed-route + 右栏几何，而不是重写 ADB。

## 2. dsh-plugin topic findings

官方发现面：根 [`README.md`](../../README.md) L59「Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic」；安装契约 [`docs/user/develop/basic/publish.md`](../../docs/user/develop/basic/publish.md)：包须 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。临时加载：`dsh web --patch ./extra.cordis.yml`。

`GET /search/repositories?q=topic:dsh-plugin+android` 当日 `total_count` **53**；`topic:dsh-plugin+mobile` **112**；`topic:dsh-plugin+ios` **20**；`topic:dsh-plugin+adb` **12**。绝大多数是 **Mobile Companion / 手机遥控 DSH**（人用手机操作电脑上的 harness），与本需求方向相反。分类：(a) 真 Cordis 插件且暴露设备控制工具；(b) 真插件但只做 logcat / 鸿蒙 / 视觉旁路；(c) Companion 噪声；(d) 伪装 `@deepseek-ai` 作用域或空壳。

### 2.1 真插件：agent 控设备 + 人可见画面（按贴合度）

| 仓库 | URL | ★ / last push | README 原句（摘） | DSH/Cordis？ | 与用户意图 | license |
|---|---|---|---|---|---|---|
| `ZSeven-W/dsh-android` | https://github.com/ZSeven-W/dsh-android | 120 / 2026-08-21 | “A live Android device inside a DeepSeek Harness conversation — emulator or USB phone, driven entirely through adb.” “20 agent tools • in-process live stream, no external helper • three-button navigation panel” | **是。** npm `@zseven-w/dsh-android` `0.1.0-rc.4`，`dsh.bundle` + `dsh.client.platform=web`，`cordis.patch.yml` insert `id: dsh-android`。客户端注册 `tool.call.toolview`、尝试 `tool.details.toolview`、`conversation.input.dock`，并 `mountAndroidPanelHost` 做右侧 dock | **最贴。** 工具 + live 流 + 人点/拖接手。模拟器与 USB 同一条 `adb devices -l` serial 路径。roadmap 已写 scrcpy-server | MIT |
| `ZSeven-W/dsh-ios` | https://github.com/ZSeven-W/dsh-ios | 257 / 2026-08-24 | “A live, interactive iOS Simulator inside a DeepSeek Harness conversation — plus your real iPhone over USB.” “22 agent tools • live MJPEG sidebar panel” | **是。** npm `@zseven-w/dsh-ios` `0.1.0-rc.5`，同样 `dsh.bundle` + `dsh.client`。依赖 `serve-sim`；真机走 WebDriverAgent + usbmux | **iOS 孪生。** 架构与 android 共享（signed `/_dsh/dsh-ios/*`、右栏、卡片、composer 胶囊）。**仅 macOS + 完整 Xcode** | MIT |
| `kunjinkao-os/dsh-mobile-gui-agent` | https://github.com/kunjinkao-os/dsh-mobile-gui-agent | 9 / 2026-08-20 | “installable DeepSeek Harness plugin for controlling Android devices through ADB … observe → decide → act → verify loop” | **是。** npm `dsh-mobile-gui-agent` `0.2.1`，`dsh.bundle` + `dsh.client`。Host 提供 `ctx.phone` / `ctx.phoneRuns`；客户端占 `conversation.view`（id `phone-agent`）和 `conversation.input.left` launcher | **GUI Agent 产品，不是 live dock。** 两个 Agent-scoped 工具 `phone_observe` / `phone_act`；有审批；**不 stream scrcpy**（README Known limitations） | MIT |

dsh-android 工具名（README Tools 节，20 个）：`android_devices`, `android_boot`, `android_shutdown`, `android_screenshot`, `android_interact`, `android_list_apps`, `android_launch_app`, `android_build_run`, `android_ui_tree`, `android_tap_element`, `android_ui_rows`, `android_tap_row`, `android_find_text`, `android_tap_text`, `android_wait_for`, `android_logs`, `android_processes`, `android_backtrace`, `android_meminfo`, `android_app_info`。OCR 三件套仅 macOS Vision。CJK 输入要可选 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)（Apache/GPL 混用；插件不捆绑）。

dsh-ios 工具名（22 个）：`ios_sim_devices`, `ios_sim_boot`, `ios_sim_shutdown`, `ios_sim_screenshot`, `ios_sim_interact`, `ios_sim_list_apps`, `ios_sim_launch_app`, `ios_sim_build_run`, `ios_real_start_wda`, `ios_sim_ui_tree`, `ios_sim_tap_element`, `ios_sim_ui_rows`, `ios_sim_tap_row`, `ios_sim_find_text`, `ios_sim_tap_text`, `ios_sim_wait_for`, `ios_sim_logs`, `ios_sim_preview`, `ios_sim_processes`, `ios_sim_backtrace`, `ios_sim_leaks`, `ios_sim_app_info`。真机 WDA：插件要求本地 checkout 在 `~/Library/Caches/dsh-ios/wda/src`，**从不 clone**；免费团队签名 7 天过期。

dsh-mobile-gui-agent 模型面：`phone_observe` + `phone_act`（一次一个严格动作，返回新 observation）。模型拿不到 raw UIAutomator XML 或任意 `adb shell`。`approvalEnabled` 对 send/publish/delete/purchase/pay/transfer/call/install/account-security 走现有 Harness approval。

### 2.2 真插件：工具或旁路 GUI，但不是 ego-lite 级基础设施

| 仓库 | ★ / push | 证据 | 缺口 |
|---|---|---|---|
| `newborne/dsh-adb-ultimate` | 5 / 2026-08-24 | `dsh.bundle` + `dsh.client`；README：会话内设备面板 5 tab（Screen 1s 刷新、Performance、Info、Apps、Logs）+ WiFi pair + tap/swipe | 1s 截帧不是 live 流；工具面未在 README 列全名；更像运维面板 |
| `mang0cola/adb_dsh_plugin` | 4 / 2026-08-14 | `dsh.bundle`；工具 `adb_devices` / `adb_device_info` / `adb_packages` / `adb_screenshot` / `adb_ui_hierarchy` / `adb_input` / `adb_app` / `adb_file` / `adb_logcat` / 可选 `adb_shell`。走 `ctx.subprocess` | **无 client 半区**，无观看窗 |
| `SamXiaBing/dsh-adb` | 2 / 2026-08-27 | `dsh.bundle` + `dsh.client`；conversation.view「设备」tab：logcat / 体检 / crash watchdog；工具 `adb_devices` `adb_logcat` `adb_install` `adb_screenshot` `adb_watch_crash` 等 | 汽车 bench / 崩溃分析，不是 GUI 操控 |
| `PangYiMing/dsh-mobile-control` | 4 / 2026-08-14 | `dsh.bundle`；8 个 `mobile_*`：`mobile_status` `mobile_wda_up` `mobile_screenshot` `mobile_find_element` `mobile_tap` `mobile_accessibility_tree` `mobile_open_url` `mobile_grant_privacy` | **仅 iOS 模拟器 WDA**；roadmap 写 Android 未做；无 client |
| `lijiajia96/dsh-tool-adb` | 1 / 2026-08-20 | README 列 `adb_devices`/`adb_shell`/`adb_install`/…；`package.json` name `@deepseek-ai/dsh-tool-adb` + `workspace:^` peers | **伪装官方作用域**，不是本仓库包。无 `dsh.bundle`。任意 `adb_shell` |
| `superclaude1/dsh-vision-android` | 2 / 2026-08-14 | `dsh.bundle`；`vision_ask` `mobile_look` `mobile_dump` `mobile_tap`/`swipe`/`text` | 外接视觉模型，无 live 面板 |
| `WindyPro-rourou/dsh-logcat` / `dxsdyhm/dsh-adb-logcat` | 4 / 0 | topic adb；logcat 查看器 | 只读日志 |
| `ns-zzj/dsh-hos-scrcpy` | 1 / 2026-08-27 | `dsh.bundle` + `dsh.client`；HDC + Java sidecar + 网页 H.264；工具 `hos_scrcpy_screenshot` | **鸿蒙 NEXT，不是 Android ADB**。架构（右侧控制区 + Host RPC + sidecar）可参考 |
| `boheastill/phone-eye` | 0 / 2026-08-25 | topic `dsh-plugin`；`package.json` 有 `dsh.bundle` 但 `main: server.py`；五个 MCP 动词 `phone_look/tap/swipe/type/screenshot` | MCP-first Python，不是 Cordis 客户端。README 自己说 “Why not a dsh-native plugin? MCP-first” |

### 2.3 Companion 噪声（不要拿来做设备自动化）

这些仓库带 `dsh-plugin` + android/mobile/ios，但产品是「人在手机上用 DSH」，与 [Mobile Companion note](../notes/proposed/feature/2026-08-17-mobile-companion.md) 同类，**明确拒绝与 agent 控设备合并**：

- `kelai141/dsh-mobile-apk` ★245 — WebView APK + 内嵌 Termux 跑 dsh
- `saya-ch/dsh-mobile` ★155 — 局域网/Tailscale 移动端适配
- `shaobeichen/dsh-pocket` ★703 — 扫码把 `dsh web` 装进口袋
- `sorsama/deepseek-harness-mobile` ★47 — Kotlin companion
- `zexadev/dsh-tether` ★25 — P2P 手机客户端
- `Clarklevis1995/dsh-mobile` ★19 — 原生 iOS 客户端
- `kriskwok/dsh-ios-app` ★4 — 遥控 DSH/Hermes 的 iOS App
- `railgun0325/dsh-phone` ★18 — Magisk root 让 agent **跑在手机里**（方向相反：设备变 runtime，不是被控对象）

`Kickstartparty3459/dsh-ios` ★0 的 description 几乎逐字复制 `ZSeven-W/dsh-ios`，未当作独立实现。

`GET /search/repositories?q=dsh-plugin+scrcpy` 当日只命中 `ns-zzj/dsh-hos-scrcpy`（鸿蒙）。**没有** Android scrcpy 的 dsh-plugin。

## 3. Head-of-ecosystem candidates（非 dsh-plugin）

按「能否同时给 agent 工具 + 人可嵌 GUI」排序。star / pushed_at 为检索时刻 REST 值。

| 仓库 | ★ / push | 协议 | Agent 工具 | 人可见画面 | 适合作 DSH 基座？ | license |
|---|---|---|---|---|---|---|
| [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) | 6037 / 2026-08-26 | MCP stdio `npx @mobilenext/mobile-mcp`；Android=adb，iOS sim=`simctl`，iOS 真机=`go-ios`+WDA+tunnel | 完整 `mobile_*`：list devices/apps，screenshot，list_elements，click/swipe/type，press_button，install/launch，screen recording，crashes | **无。** 截图当 MCP image block | **工具层最快路径**：一条 `dsh-mcp-client` 行即可。不要当 GUI。iOS 真机成本高 | Apache-2.0 |
| [JuanCF/scrcpy-mcp](https://github.com/JuanCF/scrcpy-mcp) | 86 / 2026-08-21 | MCP；scrcpy 二进制控制协议 + ADB fallback | 36 工具：`start_session` `screenshot` `tap` `swipe` `ui_dump` `ui_find_element` `shell_exec` `clipboard_*`；session 内截图 ~33ms、点击 5–10ms | `start_video_stream` 开 **ffplay 独立窗口**，不是网页 iframe | 帧率/剪贴板优于纯 ADB。`shell_exec` 对模型过宽。观看窗不在 DSH 里 | MIT |
| [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) | 148350 / 2026-08-17 | ADB + device-side server；SDL 桌面窗 | 无 agent 工具 | 桌面镜像+键鼠 | **原语，不是产品。** dsh-android roadmap 已点名 `scrcpy-server` + WebCodecs | Apache-2.0 |
| [NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) | 2541 / 2026-08-24 | 改版 scrcpy → WebSocket H.264；浏览器 MSE / Broadway | 无 DSH/MCP 工具 | 网页投屏+控制 | 若自建 details occupant，这是 Web 观看层参考。独立 Node 服务，要自己接工具 | MIT |
| [DeviceFarmer/stf](https://github.com/DeviceFarmer/stf) | 4541 / 2026-08-27 | 设备农场 Web UI（openstf 续命） | 无模型工具 | 浏览器里控多机 | 农场，不是 agent 基础设施。`openstf/stf` ★13934 已停更（2023-05） | NOASSERTION |
| [zai-org/Open-AutoGLM](https://github.com/zai-org/Open-AutoGLM) | 26099 / 2026-03-06 | Python Phone Agent；ADB + VLM（AutoGLM-Phone-9B）；HarmonyOS 走 HDC | 自然语言任务循环，不是 `defineTool` 词表 | 自有客户端；支持人工接管登录/验证码 | **模型/规划框架**，不是 DSH 插件。可当「怎么做 GUI agent」参考，不要嵌进 Cordis | Apache-2.0 |
| [appium/appium](https://github.com/appium/appium) | 21902 / 2026-08-25 | W3C WebDriver；Android UiAutomator2 / iOS XCUITest | 测试脚本 API，不是 MCP | 无 | 太重。WDA 已被 dsh-ios / mobile-mcp 直接用 | Apache-2.0 |
| [mobile-dev-inc/Maestro](https://github.com/mobile-dev-inc/Maestro) | 15432 / 2026-08-26 | YAML flows | CLI，不是 agent 工具 | 无 | E2E 测试产品 | Apache-2.0 |
| [openatx/uiautomator2](https://github.com/openatx/uiautomator2) | 8310 / 2026-08-07 | Python + atx-agent | Python API | 无 | dsh-android 已用原生 `uiautomator` dump，不必再包一层 | MIT |
| [facebook/idb](https://github.com/facebook/idb) | 5296 / 2026-08-26 | iOS companion | CLI | 无 | dsh-mobile-control README：homebrew `idb-companion` 已下架，改走 WDA | MIT |
| [danielpaulus/go-ios](https://github.com/danielpaulus/go-ios) | 2224 / 2026-08-14 | 无 Xcode 的 iOS 协议实现 | CLI；mobile-mcp 真机依赖 | 无 | iOS 真机隧道组件 | MIT |
| [appium/WebDriverAgent](https://github.com/appium/WebDriverAgent) | 1768 / 2026-08-27 | XCUITest HTTP（8100）+ MJPEG（9100） | dsh-ios `ios_real_start_wda` 的后端 | MJPEG 流 | 真机 iOS 的事实标准。要签名、信任、7 天续 | BSD-ish (NOASSERTION) |
| [EvanBacon/serve-sim](https://github.com/EvanBacon/serve-sim) | 2698 / 2026-08-21 | iOS Simulator MJPEG | 被 dsh-ios 当 npm 依赖 | MJPEG | 已在 dsh-ios 里 | Apache-2.0 |
| [cameroncooke/AXe](https://github.com/cameroncooke/AXe) | 2144 / 2026-07-21 | Simulator 私有 Accessibility CLI | dsh-ios UI-tree 后端 | 无 | 已在 dsh-ios 里 | MIT |
| [remote-android/redroid-doc](https://github.com/remote-android/redroid-doc) | 6729 / 2026-05-17 | 容器化 Android（binder） | 对 adb 仍是一台 device | 无 GUI | **虚拟机后端**，不是插件。Linux/云上无 AVD 时用 | 文档仓无 SPDX |
| [waydroid/waydroid](https://github.com/waydroid/waydroid) | 12048 / 2026-08-01 | GNU/Linux 上的 Android 容器 | 同上 | 本机窗口 | 桌面 Linux 宿主，不是 DSH 插件 | GPL-3.0 |

mobile-mcp 工具名（README “Available MCP Tools”）：

- 设备：`mobile_list_available_devices` `mobile_get_screen_size` `mobile_get_orientation` `mobile_set_orientation`
- 应用：`mobile_list_apps` `mobile_launch_app` `mobile_terminate_app` `mobile_install_app` `mobile_uninstall_app`
- 屏幕：`mobile_take_screenshot` `mobile_save_screenshot` `mobile_list_elements_on_screen` `mobile_click_on_screen_at_coordinates` `mobile_double_tap_on_screen` `mobile_long_press_on_screen_at_coordinates` `mobile_swipe_on_screen` `mobile_start_screen_recording` `mobile_stop_screen_recording`
- 输入：`mobile_type_keys` `mobile_press_button` `mobile_open_url`
- 崩溃：`mobile_list_crashes` `mobile_get_crash`

DSH 侧若只接 MCP，模型看到的是 `mcp__mobile__mobile_take_screenshot` 这种名（[`packages/mcp/mcp-client/README.md`](../../packages/mcp/mcp-client/README.md)）。MCP 只桥 Tools，不桥 Resources/Prompts。截图可在模型声明 image input 且 `ctx.attachments` 在场时变成 durable image block。

## 4. ego-lite analog and DSH GUI mapping

### 4.1 ego-lite 实际是什么

一手源：[citrolabs/ego-lite README](https://github.com/citrolabs/ego-lite/blob/main/README.md)（★13858，MIT，pushed 2026-08-27）；本机 skill [`/Users/yishu.cy/.agents/skills/ego-browser/SKILL.md`](/Users/yishu.cy/.agents/skills/ego-browser/SKILL.md) v1.2.3。

> “ego (lite) is a browser where you and your AI agents work in parallel. Your agents run multiple browser tasks in their own Spaces while your tabs stay yours”

拆分：

| 层 | ego-lite | 手机对应物（已存在） |
|---|---|---|
| 运行时进程 | 独立 Chromium（macOS app；Windows/Linux 在 roadmap） | adb / emulator / serve-sim / WDA，都在 DSH Host 进程外或作为其 child |
| Agent 面 | `ego-browser nodejs` heredoc；helpers：`snapshotText` `click` `typeText` `captureScreenshot` `useOrCreateTaskSpace` `handOffTaskSpace` `takeOverTaskSpace` | dsh-android 的 20 个 `android_*`；或 MCP `mobile_*` |
| 隔离 | Task Space：agent 自己的 tabs，**默认继承用户登录态** | 一部被授权的 debug 设备；没有「继承用户日常手机、又不打扰」——USB debugging 本身就是打扰 |
| 人看 | 同一浏览器里看到哪个 Space 有 agent，可接管/停止 | dsh-android 右侧 live PNG；dsh-ios MJPEG；composer 上 status capsule |
| 人接手 | `handOffTaskSpace`；用户随时 GUI takeover；agent 遇到 “user is controlling” 必须停 | 面板上点/拖/Back/Home/Recents；dsh-mobile-gui-agent 的 Pause/Stop + approval |
| DSH 插件形态 | [Fisfzy/dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser) `@dsh-external/ego-browser` 0.8.0：32 个 `ego_*` + SSE 观察窗 + 鼠标回传 CDP | 正是 dsh-android 已经做的那套，换了设备后端 |

ego-lite **不是**「左侧栏 iframe 打开 URL」。Skill 明确：agent 有自己的 Space，人的标签页不动。

### 4.2 DSH GUI 槽位（本仓库一手源）

权威：[2026-08-19 sidebar/browser research](2026-08-19-web-gui-sidebar-and-browser-feature.md)，[`packages/client/ui-sidebar/src/client/contract/slots.ts`](../../packages/client/ui-sidebar/src/client/contract/slots.ts)，[`packages/client/ui-layout/README.md`](../../packages/client/ui-layout/README.md)，[details width ranges](../notes/implemented/feature/2026-08-18-details-occupant-width-ranges.md)。

| 槽 | kind | 今天的占用者 | 手机画面能不能放这里 |
|---|---|---|---|
| `sidebar` | single | ui-sidebar 整列 | **不能。** 注册即替换工作区/Session 导航 |
| `sidebar.workspaces` | single | ui-workspace | 不能。会挤掉 Session 列表 |
| `sidebar.footer.action` | list | Desktop Update Control | 最多放一个「打开设备面板」图标，不是画面 |
| `details` | single | ui-conversation DetailsPanel → 子槽 `conversation.details.tool`（**所有工具共用一个 occupant**） | 几何已准备好 `openDetails({ maximum: 960 })`，但占 `conversation.details.tool` 会吃掉普通 tool details。layout note **拒绝**给 Browser Dock 第二条 grid/overlay |
| `tool.details.toolview` | 未在本树声明 | — | dsh-android / dsh-ios / dsh-openpencil **本地 declare** 并 `slots.inject` 等待；rc.6 上永远等不到，于是走 page-owned 右栏 |
| `shell.overlay` | list | 叠加层 | 窄屏时 dsh-android 的 overlay fallback |
| `conversation.input.dock` | list | — | dsh-android 的流状态胶囊（面板关闭时） |
| `conversation.view` | keyed | chat 等 | dsh-mobile-gui-agent 的独立 Phone 任务页（不是 dock） |

dsh-android 客户端源 [`src/client/index.tsx`](https://raw.githubusercontent.com/ZSeven-W/dsh-android/main/src/client/index.tsx) 文件头：

> The device display lives ONLY in the persistent right-side panel (Codex-style): the per-tool `tool.details.toolview` details seat is registered through the same `ctx.slots.inject` guard … The installed rc.6 runtime does NOT declare that seat, so on rc.6 the plugin mounts its own page-owned right panel host.

[`src/client/android-panel-dock.ts`](https://raw.githubusercontent.com/ZSeven-W/dsh-android/main/src/client/android-panel-dock.ts) 用 `#root` 的 `marginRight` 把 AppFrame 往左推（与 dsh-openpencil workbench dock 相同），并与「别人已经占的右边栏」共存；外栏超过视口 60% 则 overlay。这解释了为什么用户口语里的「sidebar」在这些插件 README 里其实是**右侧设备栏**。

### 4.3 推荐 GUI 形状

**右侧设备 dock（dsh-android 已实现）+ 可选 footer 入口。** 不要新开 `sidebar.device` 除非只要一个设备指示点。不要 iframe 嵌 scrcpy 桌面窗。若做一等公民 Browser-Dock 式 details occupant，需要 **先**在 ui-conversation 声明 keyed `tool.details.toolview`（或独立 `details` 占用者），否则第三方只能继续 page-owned host。

## 4.5 Anti-detection / 风控（相对 ego-lite）

ego-lite 的「防风控」**不是** AdsPower / Camoufox 那种指纹伪装。一手源（[citrolabs/ego-lite README](https://github.com/citrolabs/ego-lite/blob/main/README.md)、本机 ego-browser skill）写的是：

- 它**就是**日常浏览器：首次可迁移 Chrome 的 cookies / 扩展 / 书签；agent 继承真实登录态（“No login friction”“Inherits Chrome's data”）。
- 内核级 Chromium + Task Space，而不是 Playwright 另起一个 `navigator.webdriver` 浏览器去打站点。
- 验证码/登录交给人：`handOffTaskSpace`；用户随时 GUI takeover；agent 遇到 “user is controlling” 必须停。
- 明确对比 Browser-Use / agent-browser：「logins never carry cleanly」。

手机 App 风控看的是**另一组信号**，和浏览器 TLS/canvas 不是同一层：

| 信号 | 谁会看 | 本调研里的仓怎么处理 |
|---|---|---|
| USB debugging / `adb` / Developer options | 银行、支付、部分社交 | **全部 ADB 方案都要求打开。** 这是 ego「用真浏览器」在手机上**做不到的对等物**：日常真机一旦开调试，本身就是红旗 |
| 模拟器（qemu / goldfish / 无基带 / 传感器空洞） | Play Integrity、游戏、电商 | dsh-android 把模拟器和真机当成同一条 serial；**没有**隐藏模拟器。要用真机是操作选择，不是插件能力 |
| `adb shell input tap` / `input text` | 输入源、瞬时点击、无压力面积 | dsh-android README：坐标经 `input tap`。mobile-mcp / AutoGLM 同类。**无人做贝塞尔轨迹 / 压力曲线** |
| ADBKeyboard IME（`com.android.adbkeyboard`） | 输入法列表、包名 | dsh-android 可选常驻；dsh-mobile-gui-agent **仅 Unicode 时临时 enable，事后 restore IME**（这是本清单里唯一降低 IME 指纹的实现）；Open-AutoGLM 要求常驻启用 |
| UIAutomator / AccessibilityService / instrumentation | 无障碍列表、测试服务 | dsh-mobile-gui-agent **明确不装 AccessibilityService**，只用系统 UIAutomator dump。仍是测试通道，不是 HID |
| 额外 APK（WDA Runner、atx-agent、scrcpy-server） | 包列表、签名、开发者证书 | dsh-ios 真机**必须**装 WebDriverAgentRunner 并信任证书；scrcpy 会推 server；phone-eye / uiautomator2 常见 atx-agent。都是可见植入 |
| `FLAG_SECURE` 黑屏（支付/密码页） | 系统截屏策略 | Open-AutoGLM FAQ：「Screenshot Failed (Black Screen)… sensitive page… request manual takeover」——**检测敏感页后交给人**，不破解 FLAG_SECURE |
| 登录/验证码/支付 | 业务风控 | ego 的 handoff 在手机侧最接近的是：Open-AutoGLM `Take_over` + `confirmation_callback`；dsh-mobile-gui-agent 对 send/pay/transfer/install 走 Harness approval，并写「Use a test device and a non-production account」；dsh-ios「real-account tap is gated by identify-before-tap」 |
| Play Integrity / SafetyNet / Magisk hide | 设备证明 | `topic:dsh-plugin` + Play Integrity / Magisk hide / 模拟器检测 当日 **0 命中**。没有插件做这层 |

按「有没有为风控出过力」分级（不是按 star）：

| 仓 | 风控相关努力 | 仍暴露什么 | 和 ego 的距离 |
|---|---|---|---|
| **kunjinkao-os/dsh-mobile-gui-agent** | 不装 AccessibilityService；ADBKeyboard 用完还原；语义动作审批；stale-element 防止乱点；禁止任意 `adb shell` | USB debugging + UIAutomator + 仍可能短暂出现 ADBKeyboard | **人机协同/权限**最接近 ego handoff，**不是**设备指纹伪装 |
| **zai-org/Open-AutoGLM** | `Take_over`（login/captcha）；敏感页黑屏 → 人工；confirmation callback | ADB + 常驻 ADBKeyboard + `input` 点击；要开「USB 调试（安全设置）」 | 任务循环里的接管，仍是调试真机 |
| **ZSeven-W/dsh-ios** | 真机 identify-before-tap；人可在 MJPEG 上接手 | WDA 测试 App + Developer Mode + 7 天免费签名 | 接手有，植入更重 |
| **ZSeven-W/dsh-android** | 可用 USB **真机**（比 AVD 干净）；人可在 PNG 流上点/拖；CJK 拒绝静默乱码 | `input tap`；可选常驻 ADBKeyboard；持续 `screencap`；开调试 | **真机路径是 ego 精神的一半**（用真实设备，不造指纹）；另一半（不开调试、不装测试通道）它做不到 |
| **JuanCF/scrcpy-mcp** | scrcpy-server 注入比 `input tap` 更接近真实触控；剪贴板走 scrcpy 绕过 Android 10 ADB 限制 | 仍要 USB debugging + 设备上的 scrcpy-server；`shell_exec` 过宽 | 输入通道略好，无风控产品叙述 |
| **mobile-next/mobile-mcp** | 无 | 标准 adb / WDA | 无 |
| **antibrow/dsh-antibrow** | 引擎级指纹伪装、住宅代理、`deviceType: 'android'` 用**整机采集的手机浏览器画像**（whoer 90% / creepjs headless 0%） | **这是伪装成手机的桌面浏览器，不是控一部 Android。** `package.json` 几乎只有 README + patch | 和本需求层错了；它是浏览器反检测，不是手机 App 反检测 |
| Magisk / Shamiko / Play Integrity Fix 类 | 不在 dsh-plugin 生态 | — | 那是 root 隐藏栈，和 harness 插件正交，且会把日常机置于高风险 |

结论：**没有任何被核过的 dsh-plugin 在做「对 App 隐藏 ADB / 模拟器 / 测试通道」。** 和 ego 真正同构的策略是：

1. **日常真机，不开模拟器**（dsh-android 已支持，但调试开关仍在）。
2. **验证码/登录/支付交给人**（AutoGLM `Take_over`、mobile-gui-agent approval、dsh-android/ios 面板接手）。
3. **少装东西**：不要常驻 ADBKeyboard、不要 AccessibilityService、不要 WDA（真机 iOS 目前做不到）。
4. **输入走 scrcpy HID 而不是 `input tap`**（dsh-android roadmap 已写 scrcpy-server，但今天还是 screencap + `input tap`）。
5. 不要幻想插件能过 Play Integrity；那不是 Cordis 层的问题。

若产品目标是「微信/支付宝/银行也能让 agent 点」，现有仓库都不够；那是设备证明 + 输入源 + 行为时序的另一条产品，且和「给模型 ADB」直接冲突。

## 5. Proposed integration shape

### 5.1 现在就能装

```sh
dsh plugin --profile web add @zseven-w/dsh-android@latest
# optional, macOS+Xcode:
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

要求：Node ≥ 24.11（android 插件 engines）、adb 在 `ADB` / `PATH` / `ANDROID_HOME/platform-tools`、一台 `adb devices` 状态为 `device` 的模拟器或已授权 USB 手机。无 adb 时插件仍加载，工具调用会解释缺什么。

只想先验证工具、不要 GUI：

```yaml
- id: mcp-mobile
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mobile
    transport: stdio
    command: npx
    args: ['-y', '@mobilenext/mobile-mcp@latest']
    deferLoading: true
```

`deferLoading: true` 需要 `dsh-tools.toolSearch`（mcp-client README）。手机工具很多，应默认 deferred，避免撑爆初始 request。Desktop 默认**不**启用任何 MCP server（[`apps/desktop/README.md`](../../apps/desktop/README.md)）。

### 5.2 若要做官方能力缝（第二步，非现在）

对标 [`packages/shell`](../../packages/shell) 与 [capability seams](../notes/implemented/architecture/2026-06-13-capability-seams.md)：

| 角色 | 建议 | 不要 |
|---|---|---|
| Service Definition | `ctx.device`：serial/udid、revision、screenshot、tap、tree。身份用 branded id，mutations 带 `expectedRevision`（Browser Runtime 同款） | 不要把 `adb shell` 字符串暴露给模型 |
| Service Provider | `device-adb`（真机/AVD/Redroid 都是 serial）；`device-ios-simctl`；`device-ios-wda` | 不要一个 provider 同时讲 ADB 和 WDA |
| Consumer | 6–8 个 deferred 工具：`device_list` `device_open` `device_observe` `device_act` `device_screenshot` `device_close`。UI-tree 与坐标分家 | 不要 20–36 个平行工具进初始 schema（Tandem 257-tool 已被拒） |
| GUI Consumer | details occupant，`openDetails` 960px；卡片 `generic` + 打开面板；**无**专用 conversation card 直到 dock 拥有体验（Browser Dock 同样的拒绝） | 不要占 `sidebar`；不要 `shell_exec` |
| 进程 | 像 Tandem：scrcpy-server / serve-sim / WDA 是 Host 管的 child，loopback + signed route。**不要 vendor 进 `vendor/`**（vendor 只收 Cordis 框架源） | 不要让浏览器直连 adb 端口 |

Android-first：adb 一条路径覆盖 AVD / USB / `adb connect` / Redroid。iOS 真机是另一条产品（Xcode、证书、7 天 profile），不要绑进 Android provider。

### 5.3 安全

- ADB USB debugging ≈ 对该设备的 shell。`adb_shell` / scrcpy-mcp `shell_exec` / lijiajia96 的任意 shell **不应**给模型。dsh-android 没有通用 shell 工具；dsh-mobile-gui-agent 用封闭 `PhoneShellRequest`。
- dsh-android 流：进程内 PNG，`/_dsh/dsh-android/*`，loopback peer + loopback Host + Fetch-Metadata/Origin，HMAC 10 分钟，screenshot 路径 `O_NOFOLLOW`。浏览器永不直接打 adb。
- 支付/发送类：dsh-mobile-gui-agent 走 `ctx` approval；dsh-android 目前靠人看面板。官方缝应默认 `tools/pre-execute` ask。
- 截图含 PII。MCP image 进附件店的前提是路由声明 image input（mcp-client README）。
- 真机 OCR/点按有真实后果。dsh-ios README：「On a REAL device every tap has real consequences — never tap an unidentified control to find out what it does。」

### 5.4 明确不要做的

- 不要把 Mobile Companion 和设备自动化合成一个插件。
- 不要注册 `sidebar`。
- 不要把 mobile-mcp / scrcpy-mcp 的全量工具当作 DSH 词表。
- 不要为了「侧边栏里看手机」去 iframe 一个 ws-scrcpy 独立站点（cookie/origin/端口全错）。
- 不要 bundle 官方 `adb` 二进制（Android SDK 许可；dsh-android Credits 已写）。

## 5.5 二次开发基座选择（设置启用 → 装模拟器 → 再注册工具）

用户目标不是「装上立刻 20 个工具」，而是：设置页打开功能 → 引导安装 AVD / iOS Simulator → 就绪后才把工具挂进 agent；画面大，口语里叫 sidebar，实际应是右侧 dock。两边默认都不是这个生命周期。

| 你要的层 | dsh-android / dsh-ios | mobile-next（mcp + mobilecli + device-view） |
|---|---|---|
| 设置页开关、未启用不进模型 | **没有。** Host `apply` 里 20/22 个工具无条件 `register`；没 adb 也注册，调用时才报错（`src/index.ts` / `src/tools.ts` 文件头） | MCP 一行 `dsh-mcp-client` 也是一加载就发现全套 `mobile_*`。可用 `deferLoading: true` 藏 schema，**不能**表示「功能没开」 |
| 引导装 AVD / Xcode runtime | android 有 `listAvds` / `bootAvd` / `android_boot`；**不下载 system image、不跑 sdkmanager**。ios 要求本机已有完整 Xcode + runtime | mobilecli README：Android 要 PATH 上的 adb；iOS 要 Xcode + **事先 create/boot 的 simulator**。「You will have to create Simulators and have them booted before mobilecli can use them」 |
| DSH 工具卡片 / presentationMeta / Code Mode | 已接 `defineTool`、signed route、rc.6 右栏 fallback | 只有 MCP 名 `mcp__mobile__*`；无 `presentCall`，无 DSH 卡片 |
| 人看的 live 画面 + 点/拖接手 | **已有** page-owned 右栏、composer 胶囊、loopback HMAC。dsh-android 持续 `screencap` PNG（2–10 fps） | mobilecli 能 MJPEG/H264；[`react-device-view`](https://github.com/mobile-next/react-device-view) 是 WebRTC/AVC/MJPEG React 组件，但示例 `serverUrl` 指向 **Mobile Next Cloud**（`wss://app.mobilenext.ai/ws` + `mob_` token），不是本机 DSH origin |
| iOS+Android 同一套 API | **两个仓库、两套工具名** | **这是它的优势。** 一个 CLI 打四类目标 |
| 嵌进 Cordis / settings.plugin.item | 已经是 `dsh.bundle` + `dsh.client`；设置卡可按 [plugin-owned settings](../notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.md) 加 Host namespace + 浏览器卡片 | 要从 MCP 子进程改造成「未启用则零工具」，等于重写加载器 |
| 许可 | 都是 MIT | mobile-mcp Apache-2.0；**mobilecli 是 FSL-1.1-Apache-2.0**（未来 Apache，当前对竞品不友好）。devicekit-ios 同 FSL |
| 二次开发摩擦 | android 单仓 TypeScript，工具按文件切开（`tools.ts` / `tool-uitree.ts` / `client/`）；ios 是孪生仓不是 monorepo。右栏用 `#root marginRight` hack，因为本树还没 `tool.details.toolview` | mcp 是薄壳；真逻辑在 Go `mobilecli`。fork 要跨 TS+Go+Swift（devicekit-ios）+ Kotlin（devicekit-android） |

**建议：以 dsh-android（+ 需要时 dsh-ios）为产品壳做二次开发，把 mobilecli 当可选设备后端，不要 fork mobile-mcp 当 DSH 插件。**

原因：

1. 你要的 80% 产品面（DSH 工具、右栏、卡片、signed 流、人接手）只存在于 dsh 那对插件。mobile-next 的观看组件绑云 token，塞进 DSH 等于重做 dsh-android 已经做过的 origin 栅栏。
2. 「设置启用后才注册工具」必须改 Host `apply`：未启用时 `ctx.tools.register` 不跑（或 register 后立刻 dispose）。dsh-android 今天是反例（无 adb 也注册），但这是几行生命周期，不是架构重写。MCP 客户端没有「功能开关」语义。
3. 「安装 AVD / iOS 模拟器」哪边都没做完。android 已能 `bootAvd`；缺的是设置卡里跑 `sdkmanager` / `xcodebuild -downloadPlatform` 的向导，这是新 UI，不依赖选哪家自动化内核。
4. 不要占左侧 `sidebar`。设置卡放 Plugins 分区（`settings.plugin.item` keyed namespace）。画面继续右侧 dock；窄屏走 overlay。footer 最多一个「打开设备面板」入口。
5. 工具词表收到 6–8 个 deferred（`device_list` / `device_open` / `device_observe` / `device_act` / `device_close`），不要把 20 个 `android_*` 或 20 个 `mobile_*` 灌进初始 request。
6. 若 Android+iOS 必须一套动词：在 DSH Consumer 里统一，Provider 分别调 `adb` 与 `mobilecli`/`simctl`。不要让模型直接看见 MCP 名。
7. 不要整仓 fork mobile-next：FSL、云绑定、多语言。最多 spawn `npx mobilecli` 当 Tandem 式 child（loopback），类似 Browser Runtime 对 Tandem 的用法。

最小落地顺序：fork/vendor 一份 dsh-android → 加 settings namespace + 启用开关 → 开关关闭时不 register 工具、不挂流路由 → 开关打开后探测 adb/emulator，没有则设置卡引导安装 → 有 serial 再 `android_boot` 开右栏 → 帧率不够再换 scrcpy-server（它自己的 roadmap）或 mobilecli 的 h264 流。iOS 作为第二个 Provider 跟进，不要第一步就合并两个上游。

## 6. What was searched and found empty

| 查询 | 结果 |
|---|---|
| `topic:dsh-plugin` + `scrcpy` | 仅鸿蒙 `dsh-hos-scrcpy`，无 Android scrcpy 插件 |
| `topic:dsh-plugin` + `appium` / `emulator` | 无独立命中（android 集合里已覆盖 AVD） |
| 官方 `@deepseek-ai/dsh-*` 设备包 | 本仓库 `packages/` 无 android/ios/device/phone。`lijiajia96/dsh-tool-adb` 盗用作用域 |
| 本树 `packages/browser/` | 仍缺席（Browser Runtime 在 `origin/codex/feature-ai-browser`，见 2026-08-19 笔记） |
| `gh` CLI | 本环境 `command -v gh` 失败；改用 REST + raw。Search **code** API 返回 401 |
| `THUDM/AutoGLM` | 404；现仓为 `zai-org/Open-AutoGLM` |
| `redroid-org/redroid` | 404；文档在 `remote-android/redroid-doc` |

## Sources

DSH 本树：

- [`packages/client/ui-sidebar/src/client/contract/slots.ts`](../../packages/client/ui-sidebar/src/client/contract/slots.ts)
- [`packages/client/ui-layout/README.md`](../../packages/client/ui-layout/README.md)
- [`packages/client/ui-conversation/src/client/contract/slots.ts`](../../packages/client/ui-conversation/src/client/contract/slots.ts) `conversation.details.tool`
- [`packages/mcp/mcp-client/README.md`](../../packages/mcp/mcp-client/README.md)
- [`docs/user/develop/basic/publish.md`](../../docs/user/develop/basic/publish.md)
- [`docs/cookbook/adding-a-tool.md`](../../docs/cookbook/adding-a-tool.md)
- [capability seams](../notes/implemented/architecture/2026-06-13-capability-seams.md)
- [details occupant width ranges](../notes/implemented/feature/2026-08-18-details-occupant-width-ranges.md)
- [Mobile Companion (proposed)](../notes/proposed/feature/2026-08-17-mobile-companion.md)
- [2026-08-19 GUI/sidebar/browser research](2026-08-19-web-gui-sidebar-and-browser-feature.md)

外部一手（README / package.json / 客户端源，2026-08-27 REST）：

- https://github.com/ZSeven-W/dsh-android — `package.json`, `cordis.patch.yml`, `README.md`, `src/client/index.tsx`, `src/client/details-compat.ts`, `src/client/android-panel-dock.ts`
- https://github.com/ZSeven-W/dsh-ios — `package.json`, `cordis.patch.yml`, `README.md`
- https://github.com/kunjinkao-os/dsh-mobile-gui-agent — `package.json`, `cordis.patch.yml`, `README.md`, `src/client/index.ts`
- https://github.com/mobile-next/mobile-mcp — `README.md`, `package.json` (`@mobilenext/mobile-mcp`)
- https://github.com/JuanCF/scrcpy-mcp — `README.md` Tool Reference
- https://github.com/citrolabs/ego-lite — `README.md`
- https://github.com/Fisfzy/dsh-ego-browser — `package.json` (`@dsh-external/ego-browser` 0.8.0), `README.md`
- https://github.com/zai-org/Open-AutoGLM — `README_en.md`
- https://github.com/NetrisTV/ws-scrcpy — `README.md`
- https://github.com/Genymobile/scrcpy
- https://github.com/DeviceFarmer/stf
- Secondary plugin manifests: `newborne/dsh-adb-ultimate`, `mang0cola/adb_dsh_plugin`, `SamXiaBing/dsh-adb`, `PangYiMing/dsh-mobile-control`, `lijiajia96/dsh-tool-adb`, `superclaude1/dsh-vision-android`, `ns-zzj/dsh-hos-scrcpy`, `boheastill/phone-eye`
- GitHub Search: `topic:dsh-plugin+adb|android|ios|mobile`, `dsh-plugin+scrcpy`
- ego-browser skill: `/Users/yishu.cy/.agents/skills/ego-browser/SKILL.md`
