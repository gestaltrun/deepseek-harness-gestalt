# `@deepseek-ai/dsh-project-membership-desktop`

English | [中文](README.zh.md)

Desktop-only Web Host provider for authenticated Project Membership reads used by agent presets. Electron retains the Platform Account session and installation proof; this package reads a bearer token from an owner-only file and calls a token-protected loopback projection for the current public Account identity, the cloud Project bound to an Agent's Workspace, and one complete roster with public presentation fields. It exposes `ctx.desktopProjectMembership` without placing Platform credentials in the Web Host, model tool arguments, or Session log.

## Configuration

- `baseUrl` — absolute loopback HTTP origin published by Desktop Host. Non-loopback, non-HTTP, or path-bearing values fail at load.
- `tokenFile` — path to the Desktop-owned bearer-token file. The package reads the file for every request so Desktop can replace the bridge without retaining a stale credential.

`currentAccount()` is independent of a Workspace and samples the current Installation Account. `context(agent)` requires the Agent's immutable Session `cwd` and returns the signed-in Account plus the Project found from that Workspace's normalized Git remote, or from `local://workspace/<id>` when the Workspace has no origin and `ctx.workspaceRegistry` can name the cwd. `roster(actor, projectId)` requires the actor to match the current Desktop Account and retains the public identity and presence decorations for `present(view)`. `present(view)` accepts only the exact `RosterView` object returned by that service instance, preventing one roster's decorations from being attached to another read. `questionRoute(agent, addresseeLogin, originSessionTitle)` reads the current roster once and returns the bound Project, matched Account id, and authenticated Account origin only when that roster's public GitHub login matches the addressee case-insensitively; an absent member or injected Account id resolves to no route. Optional cancellation signals propagate to the loopback fetch and Desktop-owned Git and Platform reads.

Every response is parsed from `unknown`. HTTP failures, missing Account state, malformed identity or roster fields, an unbound Workspace, and an Account absent from its Project fail rather than inventing an identity or Project.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-project-members` roster results and `@deepseek-ai/dsh-tool-ask-user` member-question origin fields.

#### KV Cache effect

The provider adds no independent request prefix; consumers own the schema and append the provider-derived values only when their tools run.

## Known Limitations and Deferred Work

- **Desktop Host is required** — browser-only `dsh web` has no Account proof owner or loopback projection, so the standard preset omits `project_members` and member-directed eligibility there.
- **The bridge is read-only** — Project creation, invitations, roles, tags, and removals remain renderer-to-Desktop operations and are not exposed to agent presets.
