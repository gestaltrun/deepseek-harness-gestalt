# `@deepseek-ai/dsh-project-membership-core`

English | [中文](README.zh.md)

Project Membership provider. Every mutation — create, invite, retract, atomic accept-with-link, decline, promote/demote, tag edit, remove — runs under one serialized write chain in this process, enforces its role gate inside the operation, validates its inputs loudly (`INVALID_PROJECT_NAME`, `INVALID_REMOTE_URL`, `INVALID_TAGS`, `INVALID_LINK`), republishes the complete environment document through an atomic temp-file rename at mode `0600` under a `0700` directory, and only then emits `project-membership/roster-invalidated`. A rejected durable write rolls that operation's exact mutation batch back out of memory before the rejection returns, so no later commit can publish a row the document refused. Concurrent callers therefore observe all-or-nothing commits: eight simultaneous invites to one account settle into exactly one pending row and seven `DUPLICATE_INVITEE` rejections.

State lives per environment namespace below the configured root — `<storagePath>/<environment>/project-membership.json` — so development identities can never collide with production ones, even over one shared storage root. A document parses only against the exact recorded shape (`formatVersion 0`; foreign versions fail instead of degrading), and absence means empty first boot. Reads derive from the authoritative in-memory state that each commit just persisted.

Consumers rebuild cached roster views from the invalidation stream and `rosterVersion(projectId)`; the package's own invariant companion holds that published stream to strictly increasing projection versions — every commit advances its project by exactly one version, removals included, so a removal can never follow stale bookkeeping.

## Extension Points

Config fields: `storagePath` (directory for the durable corpus) and `environment` (`'development' | 'production'`, rejected loudly otherwise). The Loader mounts the package default export directly:

```yaml
- name: '@deepseek-ai/dsh-project-membership-core'
  config:
    storagePath: '~/.dsh/projects'
    environment: 'development'
```

Horizontal scaling requires swapping in a backend with equivalent compare-and-mutate semantics behind the same Service Definition interface; adding instances of this class around one file does not provide it. Only external nondeterminism (uuids, wall clock) reaches tests; composed scenarios run keyless over real local storage.

## Model Experience

None, as Project Membership authority stays outside agent sessions and model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Single-process writer** — one write chain serializes all mutations within a process; two processes pointed at the same storage root have no cross-process lock and can lose updates. Scaling needs a backend swap, not more instances.
- **Review-gated production stance** — development composes keylessly over local storage; routed member questions remain fail-closed behind the standing independent encryption review recorded in [the placement Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-project-membership-core.md). This package ships no transport, credentials, or plaintext.
- **No administration surfaces** — pruning declined/retracted invitations and audit export are deferred until a consumer exists.
