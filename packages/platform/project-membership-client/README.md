# `@deepseek-ai/dsh-project-membership-client`

English | [中文](README.zh.md)

Browser client for Project Membership over the HTTP consumer's `/v1/projects` routes. `ProjectMembershipHttpTransport` maps the upgrade operations — cloud-project creation, presence-decorated roster reads, invitation issue, decision, retraction, and the invitee pending-invitation poll, plus member role, function-tag, and removal administration — onto the wire contract, carrying caller-supplied Account session presentation headers on every request and never touching the installation signing key. Non-OK answers keep the stable envelope: the transport parses `{ error: { code, message } }` and rejects with a `ProjectMembershipClientError` carrying the domain code and HTTP status, so a 403 role gate surfaces as `ROLE_REQUIRED`/403; a non-JSON proxy failure falls back to `HTTP_<status>`. Every success payload is parsed from `unknown` before it reaches the UI.

## Model Experience

None, as the transport never contributes model-visible state.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- GitHub-login to account resolution and the workspace remote lookup stay composition-owned; the transport speaks account ids only.
