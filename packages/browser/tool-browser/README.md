# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

Model-facing Consumer for `ctx.browserRuntime`. It registers `browser_create`, `browser_navigate`, `browser_observe`, `browser_screenshot`, `browser_focus`, `browser_input`, and `browser_close` as ordinary deferred tools. `browser_input` sends synthetic Agent input and requires a non-empty URL or text value.

## Configuration

`timeoutMs` is the positive safe-integer cooperative timeout for every call and defaults to `30000`. Invalid values fail plugin load. The Consumer requires the Browser Runtime and tool registry; registration fails loud when `toolSearch` is disabled. When a calling Agent Session is present and `ctx.browserWorkspace` is composed, operations bind created tabs to that Session.

`tool_search` returns matching schemas but never activates tools. Eligibility remains the only discovery and dispatch authority. The tools omit custom presenters, so Host clients use the same generic MCP-style tool card path as other ordinary tools.

## Model Experience

### Browser tool discovery and results

#### What the model sees

The initial tool list omits all seven Browser tools and includes the ordinary `tool_search` schema. A search for browser capabilities returns the exact schemas in a durable result. Later requests revalidate those names against current eligible deferred definitions. Every operation result renders all Profile, Workspace, browser, tab, revision, page, screenshot, focus, close, availability, chrome, and storage facts — including unlabeled temporary Profiles, the reserved shared Profile, and `unavailable` states with their reason and reconnect flag — as JSON text. Omitting `profile` on `browser_create` uses the `ui-browser` settings default, which is the shared Profile until that page changes it. With the Session Binder composed, an omitted attach reuses an open browser instance on the matching retained Profile.

#### Token effect

Discovery adds the selected schemas to the search result and later request headers. Each operation adds its complete rendered JSON result to Session history.

#### KV Cache effect

The first request keeps the large Browser schemas out of the prefix. Discovery changes the next request's tool list, and subsequent append-only results preserve reuse after that changed prefix.

## Known Limitations and Deferred Work

- The Consumer exposes temporary, named persistent, and shared Browser Profiles and adds no account picker or browser-specific conversation card. Persistent and shared chrome are runtime facts, not a Dock header. Session-local Workspace ownership lives in [`dsh-browser-workspace`](../browser-workspace/README.md). Dock chrome lives in [`dsh-client-ui-browser`](../../client/ui-browser/README.md). Headless Browser Runtime snapshots stay Binder-free because they prove discovery and rendered Runtime facts, not Session isolation.
