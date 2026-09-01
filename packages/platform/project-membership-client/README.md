# `@deepseek-ai/dsh-project-membership-client`

English | [中文](README.zh.md)

Browser client for Project Membership over the HTTP consumer's `/v1/projects` routes. `ProjectMembershipHttpTransport` maps cloud-project creation, current-Account Project recovery by normalized remote, presence-decorated roster reads, GitHub-login invitation issue, decision, retraction, trusted invitee cards, and authoritative project-scoped issued-invitation reads, plus member role, function-tag, and removal administration, onto the wire contract. Creation and remote recovery return the authenticated Account id beside the Project so the Desktop composition can persist an exact local binding without exposing credentials. Every request carries caller-supplied Account session presentation headers and never exposes the installation signing key. Non-OK answers keep the stable envelope: the transport parses `{ error: { code, message } }` and rejects with a `ProjectMembershipClientError` carrying the domain code and HTTP status, so a 403 role gate surfaces as `ROLE_REQUIRED`/403; a non-JSON proxy failure falls back to `HTTP_<status>`. Every success payload is parsed from `unknown` before it reaches the UI. `ProjectMembershipClient` is the credential-free operation face that a Desktop-owned authenticated adapter provides to renderer consumers. `ProjectMembershipAccess` is the composition face for the shared current-installation Account state and sign-in navigation; it carries no Account token or installation key.

## Model Experience

None, as the transport never contributes model-visible state.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Local Git inspection, clone, Workspace registration, and Account/Project binding remain Host and UI composition responsibilities.
